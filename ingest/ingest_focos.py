"""Carrega os focos do satélite de referência do INPE desde 2020.

Anos fechados vêm do arquivo anual de referência. O ano sem anual (o corrente)
vem dos mensais, filtrados pelo satélite de referência: o INPE regrava o mensal
do mês atual todo dia, então ele já serve de carga diária. Um arquivo só é
baixado de novo quando a data de modificação no servidor muda.
"""

import csv
import io
import re
import tempfile
import time
import zipfile
from datetime import date

import requests

from db import conectar

BASE = "https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv"
DIR_ANUAL = f"{BASE}/anual/Brasil_sat_ref"
DIR_MENSAL = f"{BASE}/mensal/Brasil"
ANO_INICIAL = 2020
SATELITE_REFERENCIA = "AQUA_M-T"

RE_ARQUIVO = re.compile(
    r'href="(?P<nome>focos_[a-z_]+_(?P<periodo>\d{4,6})\.(?:csv|zip))".*?'
    r'indexcollastmod">(?P<modificado>[\d\- :]+?)\s*<'
)

DDL = """
create schema if not exists raw;
create table if not exists raw.focos (
    foco_id uuid primary key,
    data_hora_gmt timestamp not null,
    lat double precision not null,
    lon double precision not null,
    satelite text not null,
    municipio text,
    estado text,
    municipio_id_inpe int,
    bioma text,
    frp numeric,
    risco_fogo numeric,
    dias_sem_chuva numeric,
    precipitacao numeric,
    arquivo text not null,
    carregado_em timestamptz not null default now()
);
create index if not exists focos_arquivo_idx on raw.focos (arquivo);
create table if not exists raw.arquivos_carregados (
    arquivo text primary key,
    modificado_em text not null,
    linhas int not null,
    carregado_em timestamptz not null default now()
);
"""

COLUNAS = [
    "foco_id", "data_hora_gmt", "lat", "lon", "satelite", "municipio", "estado",
    "municipio_id_inpe", "bioma", "frp", "risco_fogo", "dias_sem_chuva",
    "precipitacao", "arquivo",
]


def requisitar(url, tentativas=5, **kwargs):
    for tentativa in range(1, tentativas + 1):
        try:
            resp = requests.get(url, timeout=300, **kwargs)
            resp.raise_for_status()
            return resp
        except requests.RequestException as erro:
            if tentativa == tentativas:
                raise
            espera = 2 ** tentativa
            print(f"falha no INPE ({erro.__class__.__name__}), nova tentativa em {espera}s")
            time.sleep(espera)


def listar(diretorio):
    html = requisitar(diretorio + "/").text
    return [m.groupdict() for m in RE_ARQUIVO.finditer(html)]


def arquivos_a_carregar():
    anuais = {
        int(a["periodo"]): a for a in listar(DIR_ANUAL) if int(a["periodo"]) >= ANO_INICIAL
    }
    mensais = [
        m for m in listar(DIR_MENSAL)
        if int(m["periodo"][:4]) >= ANO_INICIAL and int(m["periodo"][:4]) not in anuais
    ]
    for ano in range(ANO_INICIAL, date.today().year):
        if ano not in anuais and not any(m["periodo"].startswith(str(ano)) for m in mensais):
            raise RuntimeError(f"{ano} não tem arquivo anual nem mensal no INPE")
    return [(DIR_ANUAL, a) for a in anuais.values()] + [(DIR_MENSAL, m) for m in mensais]


def ler_csv(caminho, nome):
    if nome.endswith(".zip"):
        with zipfile.ZipFile(caminho) as z:
            interno = next(n for n in z.namelist() if n.endswith(".csv"))
            with z.open(interno) as f:
                yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
    else:
        with open(caminho, encoding="utf-8", newline="") as f:
            yield from csv.DictReader(f)


def vazio_para_none(valor):
    valor = (valor or "").strip()
    return valor or None


def normalizar(registro, nome):
    r = {k.strip(): (v or "").strip() for k, v in registro.items()}
    if "foco_id" in r:
        # Anual de referência: só tem o satélite de referência e não traz
        # código IBGE nem variáveis meteorológicas.
        return (
            r["foco_id"], r["data_pas"], r["lat"], r["lon"], SATELITE_REFERENCIA,
            vazio_para_none(r["municipio"]), vazio_para_none(r["estado"]), None,
            vazio_para_none(r["bioma"]), None, None, None, None, nome,
        )
    if r["satelite"] != SATELITE_REFERENCIA:
        return None
    return (
        r["id"], r["data_hora_gmt"], r["lat"], r["lon"], r["satelite"],
        vazio_para_none(r["municipio"]), vazio_para_none(r["estado"]),
        vazio_para_none(r["municipio_id"]), vazio_para_none(r["bioma"]),
        vazio_para_none(r["frp"]), vazio_para_none(r["risco_fogo"]),
        vazio_para_none(r["numero_dias_sem_chuva"]), vazio_para_none(r["precipitacao"]),
        nome,
    )


def carregar(conn, diretorio, arquivo):
    nome = arquivo["nome"]
    with tempfile.NamedTemporaryFile(suffix=nome) as tmp:
        with requisitar(f"{diretorio}/{nome}", stream=True) as resp:
            for bloco in resp.iter_content(1 << 20):
                tmp.write(bloco)
        tmp.flush()
        linhas = [l for l in (normalizar(r, nome) for r in ler_csv(tmp.name, nome)) if l]

    with conn.transaction():
        conn.execute("create temp table focos_tmp (like raw.focos including defaults) on commit drop")
        with conn.cursor().copy(f"copy focos_tmp ({', '.join(COLUNAS)}) from stdin") as copy:
            for linha in linhas:
                copy.write_row(linha)
        # O arquivo substitui por inteiro o que ele mesmo carregou antes: assim um
        # foco que o INPE removeu numa revisão também sai daqui.
        conn.execute("delete from raw.focos where arquivo = %s", (nome,))
        conn.execute(
            f"""insert into raw.focos ({', '.join(COLUNAS)})
                select distinct on (foco_id) {', '.join(COLUNAS)} from focos_tmp
                on conflict (foco_id) do update set
                {', '.join(f'{c} = excluded.{c}' for c in COLUNAS if c != 'foco_id')},
                carregado_em = now()"""
        )
        conn.execute(
            """insert into raw.arquivos_carregados (arquivo, modificado_em, linhas)
               values (%s, %s, %s)
               on conflict (arquivo) do update set modificado_em = excluded.modificado_em,
                   linhas = excluded.linhas, carregado_em = now()""",
            (nome, arquivo["modificado"], len(linhas)),
        )
    return len(linhas)


def main():
    with conectar() as conn:
        # Cada arquivo vira uma transação própria em carregar(): se um falhar,
        # os anteriores já ficaram gravados e a próxima execução retoma dali.
        conn.autocommit = True
        conn.execute(DDL)
        ja_carregados = dict(
            conn.execute("select arquivo, modificado_em from raw.arquivos_carregados").fetchall()
        )
        for diretorio, arquivo in arquivos_a_carregar():
            if ja_carregados.get(arquivo["nome"]) == arquivo["modificado"]:
                continue
            n = carregar(conn, diretorio, arquivo)
            print(f"{arquivo['nome']}: {n} focos do satélite de referência")


if __name__ == "__main__":
    main()

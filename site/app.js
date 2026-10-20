const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_LONGOS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
  "setembro", "outubro", "novembro", "dezembro"];
const REGIOES = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"];
const RAMPA = [[255, 224, 138], [253, 174, 75], [240, 98, 45], [179, 23, 43]];
const BRASIL = [[-74, -34], [-34.5, 5.5]];
const num = new Intl.NumberFormat("pt-BR");
const $ = (id) => document.getElementById(id);

// Detalhe por zoom: o hexágono que resume o país cobre vários municípios quando
// se chega perto de uma cidade. A partir de PONTOS_A_PARTIR_DO_ZOOM, cada foco
// aparece sozinho.
const RESOLUCOES = [
  { ateZoom: 5, res: 5, escopo: "por hexágono de 253 km²" },
  { ateZoom: 6.5, res: 6, escopo: "por hexágono de 36 km²" },
  { ateZoom: 8, res: 7, escopo: "por hexágono de 5 km²" },
];
const PONTOS_A_PARTIR_DO_ZOOM = 8;

// mun é o filtro por município; municipio é o que está aberto no painel.
const estado = {
  ano: null, mesIni: 1, mesFim: 12, bioma: -1, regiao: "", uf: "", mun: -1,
  camada: "hex", municipio: -1,
};
const cache = { focos: {}, celulas: {}, geo: null };
// lista[i] = [código IBGE, nome, UF, região, [xmin, ymin, xmax, ymax]]
let meta, ultimo, mapa, overlay, detalheAtual, lista, series, indicePorCodigo, porMes, animacao = null;

// --- dados ----------------------------------------------------------------

async function json(caminho) {
  const resp = await fetch(caminho);
  if (!resp.ok) throw new Error(`${caminho}: HTTP ${resp.status}`);
  return resp.json();
}

// data/focos/AAAA.json é uma sequência [lat*1000, lon*1000, dia do ano, bioma, município, ...].
async function focos(ano) {
  cache.focos[ano] ??= json(`data/focos/${ano}.json`).then((bruto) => {
    const n = bruto.length / 5;
    const f = { n, lat: new Float32Array(n), lon: new Float32Array(n), dia: new Uint16Array(n),
      mes: new Uint8Array(n), bioma: new Uint8Array(n), mun: new Int16Array(n) };
    for (let i = 0; i < n; i++) {
      f.lat[i] = bruto[5 * i] / 1000;
      f.lon[i] = bruto[5 * i + 1] / 1000;
      f.dia[i] = bruto[5 * i + 2];
      f.mes[i] = new Date(Date.UTC(ano, 0, f.dia[i])).getUTCMonth() + 1;
      f.bioma[i] = bruto[5 * i + 3];
      f.mun[i] = bruto[5 * i + 4];
    }
    return f;
  });
  return cache.focos[ano];
}

async function celulas(ano, res) {
  const chave = `${ano}-${res}`;
  if (!cache.celulas[chave]) {
    const f = await focos(ano);
    cache.celulas[chave] = Array.from({ length: f.n }, (_, i) => h3.latLngToCell(f.lat[i], f.lon[i], res));
  }
  return cache.celulas[chave];
}

function malha() {
  cache.geo ??= json("data/municipios.geojson");
  return cache.geo;
}

function detalhe(zoom) {
  if (zoom >= PONTOS_A_PARTIR_DO_ZOOM) return { pontos: true, escopo: "(cada ponto é um foco)" };
  return RESOLUCOES.find((r) => zoom < r.ateZoom) || RESOLUCOES.at(-1);
}

// --- filtros --------------------------------------------------------------

const passaBioma = (b) => estado.bioma === -1 || b === estado.bioma;
const passaMes = (m) => m >= estado.mesIni && m <= estado.mesFim;
const intervalo = (ini, fim) => Array.from({ length: fim - ini + 1 }, (_, i) => ini + i);
const mesesSelecionados = () => intervalo(estado.mesIni, estado.mesFim);
const anoInteiro = () => estado.mesIni === 1 && estado.mesFim === 12;

function passaGeo(i) {
  if (i < 0) return estado.mun === -1 && !estado.uf && !estado.regiao;
  if (estado.mun !== -1) return i === estado.mun;
  if (estado.uf) return lista[i][2] === estado.uf;
  if (estado.regiao) return lista[i][3] === estado.regiao;
  return true;
}

const filtroAtivo = () => estado.bioma !== -1 || estado.regiao || estado.uf || estado.mun !== -1 || !anoInteiro();

function nomeMunicipio(i) {
  return `${lista[i][1]} (${lista[i][2]})`;
}

function recorteGeo() {
  if (estado.mun !== -1) return { nome: nomeMunicipio(estado.mun), artigo: "do município" };
  if (estado.uf) return { nome: estado.uf, artigo: "do estado" };
  if (estado.regiao) return { nome: estado.regiao, artigo: "da região" };
  return { nome: "Brasil", artigo: "do país" };
}

// Soma por AAAAMM para o recorte atual de lugar e bioma. Cards e gráfico leem
// daqui, então respeitam os mesmos filtros que o mapa.
function calcularPorMes() {
  porMes = new Map();
  for (let i = 0; i < lista.length; i++) {
    if (!passaGeo(i)) continue;
    const s = series[lista[i][0]];
    if (!s) continue;
    for (let k = 0; k < s.length; k += 3) {
      if (passaBioma(s[k + 1])) porMes.set(s[k], (porMes.get(s[k]) || 0) + s[k + 2]);
    }
  }
}

const total = (ano, meses) => meses.reduce((soma, m) => soma + (porMes.get(ano * 100 + m) || 0), 0);

function focosMunicipio(i, ano, meses) {
  const s = series[lista[i][0]] || [];
  let soma = 0;
  for (let k = 0; k < s.length; k += 3) {
    if (Math.floor(s[k] / 100) === ano && meses.includes(s[k] % 100) && passaBioma(s[k + 1])) soma += s[k + 2];
  }
  return soma;
}

// O último mês com dado ainda está em andamento quando o último foco não é do
// último dia dele. Comparar esse mês parcial com o mês cheio do ano anterior
// mostraria uma queda que não existe.
function calcularUltimo() {
  const [ano, mes] = meta.meses.at(-1).split("-").map(Number);
  const data = new Date(meta.ultimo_foco_gmt + "Z");
  const fimDoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return { ano, mes, dia: data.getUTCDate(), parcial: data.getUTCDate() < fimDoMes };
}

// --- cor ------------------------------------------------------------------

function cor(focos, max, alfa = 230) {
  if (!focos) return [0, 0, 0, 0];
  const t = max <= 1 ? 1 : Math.min(1, Math.log(focos) / Math.log(max));
  const pos = t * (RAMPA.length - 1);
  const i = Math.min(RAMPA.length - 2, Math.floor(pos));
  const f = pos - i;
  return [...RAMPA[i].map((c, k) => Math.round(c + (RAMPA[i + 1][k] - c) * f)), alfa];
}

function percentil99(valores) {
  if (!valores.length) return 1;
  const ord = [...valores].sort((a, b) => a - b);
  return Math.max(1, ord[Math.floor(ord.length * 0.99)]);
}

// --- camadas --------------------------------------------------------------

function dataDoFoco(ano, dia) {
  return new Date(Date.UTC(ano, 0, dia)).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

async function camadaHex() {
  const f = await focos(estado.ano);
  detalheAtual = detalhe(mapa.getZoom());
  const passa = (i) => passaMes(f.mes[i]) && passaBioma(f.bioma[i]) && passaGeo(f.mun[i]);

  if (detalheAtual.pontos) {
    const indices = [];
    for (let i = 0; i < f.n; i++) if (passa(i)) indices.push(i);
    legenda(null, detalheAtual.escopo);
    const ano = estado.ano;
    return new deck.ScatterplotLayer({
      id: `pontos-${ano}`,
      data: indices,
      getPosition: (i) => [f.lon[i], f.lat[i]],
      getFillColor: [...RAMPA[2], 230],
      getLineColor: [255, 224, 138, 200],
      stroked: true,
      lineWidthMinPixels: 1,
      // O pixel do sensor MODIS tem 1 km: o círculo mostra a área que o foco representa.
      getRadius: 500,
      radiusUnits: "meters",
      radiusMinPixels: 3,
      pickable: true,
      onHover: ({ object, x, y }) => dica(object !== undefined && object !== null &&
        `Foco em <strong>${dataDoFoco(ano, f.dia[object])}</strong><br>` +
        `${f.mun[object] >= 0 ? nomeMunicipio(f.mun[object]) + " · " : ""}${meta.biomas[f.bioma[object]]}`, x, y),
    });
  }

  const cel = await celulas(estado.ano, detalheAtual.res);
  const soma = new Map();
  for (let i = 0; i < f.n; i++) if (passa(i)) soma.set(cel[i], (soma.get(cel[i]) || 0) + 1);
  const dados = [...soma].map(([h, n]) => ({ h, f: n }));
  const max = percentil99(dados.map((d) => d.f));
  legenda(max, detalheAtual.escopo);
  return new deck.H3HexagonLayer({
    id: `hex-${detalheAtual.res}`,
    data: dados,
    getHexagon: (d) => d.h,
    getFillColor: (d) => cor(d.f, max),
    stroked: false,
    extruded: false,
    pickable: true,
    onHover: ({ object, x, y }) =>
      dica(object && `<strong>${num.format(object.f)}</strong> ${object.f === 1 ? "foco" : "focos"} neste hexágono`, x, y),
  });
}

async function camadaMun() {
  const geo = await malha();
  const meses = mesesSelecionados();
  const focosPorCodigo = new Map();
  lista.forEach((m, i) => {
    if (!passaGeo(i)) return;
    const n = focosMunicipio(i, estado.ano, meses);
    if (n) focosPorCodigo.set(m[0], n);
  });
  const max = percentil99([...focosPorCodigo.values()]);
  legenda(max, "por município");
  const aberto = estado.municipio >= 0 ? lista[estado.municipio][0] : null;
  const chave = `${estado.ano}-${estado.mesIni}-${estado.mesFim}-${estado.bioma}-${estado.regiao}-${estado.uf}-${estado.mun}-${aberto}`;
  return new deck.GeoJsonLayer({
    id: "mun",
    data: geo,
    getFillColor: (f) => cor(focosPorCodigo.get(f.properties.id), max, 215),
    getLineColor: (f) => (f.properties.id === aberto ? [255, 255, 255, 255]
      : passaGeo(indicePorCodigo.get(f.properties.id)) ? [255, 255, 255, 22] : [255, 255, 255, 6]),
    getLineWidth: (f) => (f.properties.id === aberto ? 2 : 0.4),
    lineWidthUnits: "pixels",
    stroked: true,
    pickable: true,
    updateTriggers: { getFillColor: chave, getLineColor: chave, getLineWidth: chave },
    onHover: ({ object, x, y }) => dica(object &&
      `<strong>${object.properties.nome} (${object.properties.uf})</strong><br>` +
      `${num.format(focosPorCodigo.get(object.properties.id) || 0)} focos`, x, y),
    onClick: ({ object }) => {
      if (!object) return;
      estado.municipio = indicePorCodigo.get(object.properties.id);
      atualizarMunicipio();
      mostrarMunicipio();
      desenharMapa();
    },
  });
}

async function desenharMapa() {
  const camada = estado.camada === "hex" ? await camadaHex() : await camadaMun();
  overlay.setProps({ layers: [camada] });
}

function legenda(max, escopo) {
  $("leg-escopo").textContent = escopo;
  $("rampa").hidden = max === null;
  if (max !== null) $("leg-max").textContent = num.format(max) + "+";
}

function dica(html, x, y) {
  const el = $("tooltip");
  if (!html) { el.hidden = true; return; }
  el.innerHTML = html;
  el.hidden = false;
  el.style.left = `${Math.min(x + 14, innerWidth - el.offsetWidth - 8)}px`;
  el.style.top = `${y + 14}px`;
}

function enquadrar() {
  let caixa = null;
  if (estado.mun !== -1 || estado.uf || estado.regiao) {
    lista.forEach((m, i) => {
      if (!passaGeo(i)) return;
      const [x0, y0, x1, y1] = m[4];
      caixa = caixa ? [Math.min(caixa[0], x0), Math.min(caixa[1], y0), Math.max(caixa[2], x1), Math.max(caixa[3], y1)]
        : [x0, y0, x1, y1];
    });
  }
  const limites = caixa ? [[caixa[0], caixa[1]], [caixa[2], caixa[3]]] : BRASIL;
  mapa.fitBounds(limites, { padding: margens(), maxZoom: 10, duration: 900 });
}

function margens() {
  return matchMedia("(max-width: 720px)").matches
    ? { top: 20, bottom: innerHeight * 0.5, left: 10, right: 10 }
    : { top: 40, bottom: 40, left: 380, right: 40 };
}

// --- painel ---------------------------------------------------------------

function rotuloMeses(meses, ano) {
  if (meses.length === 12) return `${ano}`;
  if (meses.length === 1) return `${MESES[meses[0] - 1]}/${ano}`;
  return `${MESES[meses[0] - 1]}–${MESES[meses.at(-1) - 1]} de ${ano}`;
}

function mesesComparaveis() {
  const meses = mesesSelecionados();
  if (estado.ano !== ultimo.ano) return meses;
  const fechado = ultimo.parcial ? ultimo.mes - 1 : ultimo.mes;
  return meses.filter((m) => m <= fechado);
}

function atualizarCards() {
  const meses = mesesSelecionados();
  const incluiParcial = estado.ano === ultimo.ano && ultimo.parcial && meses.includes(ultimo.mes);
  const periodo = anoInteiro() ? `${estado.ano}`
    : meses.length === 1 ? `${MESES_LONGOS[meses[0] - 1]} de ${estado.ano}`
    : rotuloMeses(meses, estado.ano);
  $("rotulo-periodo").textContent = `Focos em ${periodo}` +
    (incluiParcial ? ` (até ${ultimo.dia}/${String(ultimo.mes).padStart(2, "0")})` : "");
  $("total").textContent = num.format(total(estado.ano, meses));

  const partes = [recorteGeo().nome];
  if (estado.bioma !== -1) partes.push(meta.biomas[estado.bioma]);
  $("recorte").textContent = partes.join(" · ");
  $("limpar").hidden = !filtroAtivo();
  // Região, estado e município são um filtro só: escolher o município preenche os outros dois.
  const extras = [!anoInteiro(), estado.regiao || estado.uf || estado.mun !== -1].filter(Boolean).length;
  $("n-filtros").textContent = extras ? `(${extras} ativo${extras > 1 ? "s" : ""})` : "";

  const variacao = $("variacao");
  variacao.className = "";
  const anterior = estado.ano - 1;
  if (!meta.meses.some((m) => m.startsWith(`${anterior}-`))) {
    $("rotulo-variacao").textContent = "sem ano anterior na série";
    variacao.textContent = "–";
    return;
  }
  const comparaveis = mesesComparaveis();
  if (!comparaveis.length) {
    $("rotulo-variacao").textContent = estado.mesIni > ultimo.mes ? "mês sem dado ainda" : "mês em andamento";
    variacao.textContent = "–";
    return;
  }
  const base = total(anterior, comparaveis);
  $("rotulo-variacao").textContent = `vs. ${rotuloMeses(comparaveis, anterior)}`;
  if (!base) { variacao.textContent = "–"; return; }
  const pct = (total(estado.ano, comparaveis) / base - 1) * 100;
  variacao.textContent = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(0)}%`;
  variacao.className = pct > 0 ? "sobe" : "desce";
}

function svg(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function desenharBarras() {
  const alvo = $("barras");
  const largura = alvo.clientWidth || 300;
  const altura = alvo.clientHeight || 130;
  const base = altura - 16;
  const atual = MESES.map((_, i) => total(estado.ano, [i + 1]));
  const anterior = MESES.map((_, i) => total(estado.ano - 1, [i + 1]));
  const max = Math.max(1, ...atual, ...anterior);
  const passo = largura / 12;
  alvo.setAttribute("viewBox", `0 0 ${largura} ${altura}`);
  alvo.replaceChildren();
  MESES.forEach((nome, i) => {
    const x = i * passo;
    const g = svg("g", { class: "barra" });
    g.append(svg("rect", { x, y: 0, width: passo, height: altura, fill: "transparent" }));
    const hAnt = (anterior[i] / max) * (base - 4);
    g.append(svg("rect", { x: x + 2, y: base - hAnt, width: passo - 4, height: hAnt, rx: 2, fill: "var(--anterior)" }));
    const hAt = (atual[i] / max) * (base - 4);
    g.append(svg("rect", {
      x: x + passo * 0.22, y: base - hAt, width: passo * 0.56, height: hAt, rx: 2,
      fill: "var(--fogo-2)", opacity: passaMes(i + 1) ? 1 : 0.3,
    }));
    const rotulo = svg("text", { x: x + passo / 2, y: altura - 3, "text-anchor": "middle" });
    rotulo.textContent = nome[0].toUpperCase();
    g.append(rotulo);
    const titulo = svg("title", {});
    titulo.textContent = `${nome}/${estado.ano}: ${num.format(atual[i])} focos · ${nome}/${estado.ano - 1}: ${num.format(anterior[i])}`;
    g.append(titulo);
    g.addEventListener("click", () => {
      pararAnimacao();
      const sozinho = estado.mesIni === i + 1 && estado.mesFim === i + 1;
      [estado.mesIni, estado.mesFim] = sozinho ? [1, 12] : [i + 1, i + 1];
      atualizar();
    });
    alvo.append(g);
  });
  $("leg-atual").textContent = estado.ano;
  $("leg-anterior").textContent = estado.ano - 1;
}

function mostrarMunicipio() {
  requestAnimationFrame(() => $("municipio").scrollIntoView({ block: "nearest", behavior: "smooth" }));
}

function atualizarMunicipio() {
  const caixa = $("municipio");
  if (estado.municipio < 0) {
    caixa.hidden = true;
    $("dica-municipio").hidden = false;
    return;
  }
  const i = estado.municipio;
  const meses = mesesSelecionados();
  const n = focosMunicipio(i, estado.ano, meses);
  // Ranking dentro do recorte de lugar acima do município: com filtro de
  // estado, a posição é no estado; sem filtro, no país.
  const escopo = estado.uf ? { teste: (j) => lista[j][2] === estado.uf, nome: "do estado" }
    : estado.regiao ? { teste: (j) => lista[j][3] === estado.regiao, nome: "da região" }
    : { teste: () => true, nome: "do país" };
  let posicao = 1;
  for (let j = 0; j < lista.length; j++) {
    if (j !== i && escopo.teste(j) && focosMunicipio(j, estado.ano, meses) > n) posicao++;
  }
  $("mun-nome").textContent = nomeMunicipio(i);
  $("mun-resumo").innerHTML = n
    ? `<strong>${num.format(n)}</strong> focos no período · ${posicao}º ${escopo.nome}`
    : "Nenhum foco no período selecionado.";

  const s = series[lista[i][0]] || [];
  const mensal = new Map();
  for (let k = 0; k < s.length; k += 3) {
    if (passaBioma(s[k + 1])) mensal.set(s[k], (mensal.get(s[k]) || 0) + s[k + 2]);
  }
  const alvo = $("mun-serie");
  const largura = alvo.clientWidth || 300;
  const altura = alvo.clientHeight || 80;
  const valores = meta.meses.map((m) => mensal.get(Number(m.replace("-", ""))) || 0);
  const max = Math.max(1, ...valores);
  const passo = largura / valores.length;
  alvo.setAttribute("viewBox", `0 0 ${largura} ${altura}`);
  alvo.replaceChildren();
  valores.forEach((v, k) => {
    const [ano, mes] = meta.meses[k].split("-").map(Number);
    const destaque = ano === estado.ano && passaMes(mes);
    const h = (v / max) * (altura - 2);
    alvo.append(svg("rect", {
      x: k * passo, y: altura - h, width: Math.max(1, passo - 1), height: h,
      fill: destaque ? "var(--fogo-2)" : "var(--anterior)",
    }));
  });
  $("mun-eixo").textContent = `${meta.meses[0].slice(0, 4)} a ${meta.meses.at(-1).slice(0, 4)} · máx. ${num.format(max)} focos/mês · em laranja, o período selecionado`;
  caixa.hidden = false;
  $("dica-municipio").hidden = true;
}

async function atualizar() {
  calcularPorMes();
  atualizarCards();
  desenharBarras();
  atualizarMunicipio();
  await desenharMapa();
}

// --- controles ------------------------------------------------------------

function preencherEstados() {
  const ufs = [...new Set(lista.filter((m) => !estado.regiao || m[3] === estado.regiao).map((m) => m[2]))].sort();
  $("uf").replaceChildren(new Option("Todos", ""), ...ufs.map((uf) => new Option(uf, uf)));
  $("uf").value = estado.uf;
}

function preencherMunicipios() {
  const opcoes = [];
  lista.forEach((m, i) => {
    if ((!estado.uf || m[2] === estado.uf) && (!estado.regiao || m[3] === estado.regiao)) {
      const o = document.createElement("option");
      o.value = nomeMunicipio(i);
      opcoes.push(o);
    }
  });
  $("lista-mun").replaceChildren(...opcoes);
  $("mun").value = estado.mun === -1 ? "" : nomeMunicipio(estado.mun);
}

function sincronizarControles() {
  $("ano").value = estado.ano;
  $("bioma").value = estado.bioma;
  $("regiao").value = estado.regiao;
  $("mes-ini").value = estado.mesIni;
  $("mes-fim").value = estado.mesFim;
  preencherEstados();
  preencherMunicipios();
}

function mudarLugar(mudanca) {
  Object.assign(estado, mudanca);
  // Um filtro mais amplo que não contém o mais estreito derruba o mais estreito.
  if (estado.uf && estado.regiao && !lista.some((m) => m[2] === estado.uf && m[3] === estado.regiao)) estado.uf = "";
  if (estado.mun !== -1 && ((estado.uf && lista[estado.mun][2] !== estado.uf)
    || (estado.regiao && lista[estado.mun][3] !== estado.regiao))) estado.mun = -1;
  estado.municipio = estado.mun;
  sincronizarControles();
  enquadrar();
  atualizar();
  if (estado.mun !== -1) mostrarMunicipio();
}

function ligarControles() {
  const mesesOpcoes = () => MESES_LONGOS.map((m, i) => new Option(m[0].toUpperCase() + m.slice(1), i + 1));
  $("mes-ini").append(...mesesOpcoes());
  $("mes-fim").append(...mesesOpcoes());
  $("regiao").append(...REGIOES.map((r) => new Option(r, r)));
  $("bioma").append(...meta.biomas.slice(0, -1).map((b, i) => new Option(b, i)));
  const anos = [...new Set(meta.meses.map((m) => Number(m.slice(0, 4))))].reverse();
  $("ano").append(...anos.map((a) => new Option(a, a)));

  $("ano").addEventListener("change", (e) => {
    pararAnimacao(); estado.ano = Number(e.target.value); atualizar();
  });
  $("bioma").addEventListener("change", (e) => { estado.bioma = Number(e.target.value); atualizar(); });
  $("regiao").addEventListener("change", (e) => mudarLugar({ regiao: e.target.value }));
  $("uf").addEventListener("change", (e) => mudarLugar({ uf: e.target.value }));
  $("mun").addEventListener("change", (e) => {
    const texto = e.target.value.trim();
    if (!texto) { mudarLugar({ mun: -1 }); return; }
    const i = lista.findIndex((_, k) => nomeMunicipio(k).toLowerCase() === texto.toLowerCase());
    if (i === -1) { e.target.setCustomValidity("Escolha um município da lista"); e.target.reportValidity(); return; }
    e.target.setCustomValidity("");
    mudarLugar({ mun: i, uf: lista[i][2], regiao: lista[i][3] });
  });
  $("mes-ini").addEventListener("change", (e) => {
    pararAnimacao();
    estado.mesIni = Number(e.target.value);
    if (estado.mesFim < estado.mesIni) estado.mesFim = estado.mesIni;
    sincronizarControles(); atualizar();
  });
  $("mes-fim").addEventListener("change", (e) => {
    pararAnimacao();
    estado.mesFim = Number(e.target.value);
    if (estado.mesIni > estado.mesFim) estado.mesIni = estado.mesFim;
    sincronizarControles(); atualizar();
  });
  $("limpar").addEventListener("click", () => {
    pararAnimacao();
    Object.assign(estado, { mesIni: 1, mesFim: 12, bioma: -1, regiao: "", uf: "", mun: -1, municipio: -1 });
    sincronizarControles(); enquadrar(); atualizar();
  });
  $("play").addEventListener("click", animar);
  $("mun-fechar").addEventListener("click", () => {
    if (estado.mun === estado.municipio) mudarLugar({ mun: -1 });
    else { estado.municipio = -1; atualizar(); }
  });
  document.querySelectorAll(".camada button").forEach((botao) => botao.addEventListener("click", () => {
    estado.camada = botao.dataset.camada;
    document.querySelectorAll(".camada button").forEach((b) => {
      b.classList.toggle("ativo", b === botao);
      b.setAttribute("aria-checked", b === botao);
    });
    atualizar();
  }));
}

// --- animação -------------------------------------------------------------

function pararAnimacao() {
  if (!animacao) return;
  clearInterval(animacao);
  animacao = null;
  $("play").textContent = "▶";
}

function animar() {
  if (animacao) { pararAnimacao(); return; }
  const ultimoMes = estado.ano === ultimo.ano ? ultimo.mes : 12;
  estado.mesIni = estado.mesFim = 1;
  sincronizarControles(); atualizar();
  $("play").textContent = "❚❚";
  animacao = setInterval(() => {
    if (estado.mesIni >= ultimoMes) { pararAnimacao(); return; }
    estado.mesIni = estado.mesFim = estado.mesIni + 1;
    sincronizarControles(); atualizar();
  }, 1100);
}

// --- início ---------------------------------------------------------------

async function iniciar() {
  [meta, lista, series] = await Promise.all([
    json("data/meta.json"), json("data/municipios_lista.json"), json("data/municipios_series.json"),
  ]);
  indicePorCodigo = new Map(lista.map((m, i) => [m[0], i]));
  ultimo = calcularUltimo();
  estado.ano = ultimo.ano;
  $("atualizado").textContent =
    `dados até ${new Date(meta.ultimo_foco_gmt + "Z").toLocaleDateString("pt-BR", { timeZone: "UTC" })}`;
  ligarControles();
  sincronizarControles();

  const celular = matchMedia("(max-width: 720px)").matches;
  // No celular o painel é curto: os filtros extras começam fechados para os
  // números aparecerem sem rolar.
  $("mais-filtros").open = !celular;
  mapa = new maplibregl.Map({
    container: "mapa",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    bounds: BRASIL,
    fitBoundsOptions: { padding: margens() },
    attributionControl: false,
  });
  // No celular o painel cobre o canto de baixo, então o crédito sobe.
  mapa.addControl(new maplibregl.AttributionControl({ compact: true }), celular ? "top-left" : "bottom-right");
  mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  overlay = new deck.MapboxOverlay({ layers: [] });
  mapa.addControl(overlay);
  addEventListener("resize", () => { desenharBarras(); atualizarMunicipio(); });
  mapa.on("zoomend", () => {
    if (estado.camada !== "hex") return;
    const novo = detalhe(mapa.getZoom());
    if (novo.escopo !== detalheAtual?.escopo) desenharMapa();
  });

  await atualizar();
}

iniciar().catch((erro) => {
  console.error(erro);
  $("atualizado").textContent = "erro ao carregar os dados";
});

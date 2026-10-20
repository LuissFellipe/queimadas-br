const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_LONGOS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
  "setembro", "outubro", "novembro", "dezembro"];
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

const estado = { ano: null, mes: 0, bioma: -1, camada: "hex", municipio: null };
const cache = { focos: {}, celulas: {}, geo: null, series: null };
let meta, ultimo, mapa, overlay, detalheAtual, animacao = null;

// --- dados ----------------------------------------------------------------

async function json(caminho) {
  const resp = await fetch(caminho);
  if (!resp.ok) throw new Error(`${caminho}: HTTP ${resp.status}`);
  return resp.json();
}

// data/focos/AAAA.json é uma sequência [lat*1000, lon*1000, dia do ano, bioma, ...].
async function focos(ano) {
  cache.focos[ano] ??= json(`data/focos/${ano}.json`).then((bruto) => {
    const n = bruto.length / 4;
    const f = { n, lat: new Float32Array(n), lon: new Float32Array(n), dia: new Uint16Array(n),
      mes: new Uint8Array(n), bioma: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      f.lat[i] = bruto[4 * i] / 1000;
      f.lon[i] = bruto[4 * i + 1] / 1000;
      f.dia[i] = bruto[4 * i + 2];
      f.mes[i] = new Date(Date.UTC(ano, 0, f.dia[i])).getUTCMonth() + 1;
      f.bioma[i] = bruto[4 * i + 3];
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

function detalhe(zoom) {
  if (zoom >= PONTOS_A_PARTIR_DO_ZOOM) return { pontos: true, escopo: "(cada ponto é um foco)" };
  return RESOLUCOES.find((r) => zoom < r.ateZoom) || RESOLUCOES.at(-1);
}

async function municipios() {
  cache.geo ??= json("data/municipios.geojson");
  cache.series ??= json("data/municipios_series.json");
  return Promise.all([cache.geo, cache.series]);
}

const passaBioma = (b) => estado.bioma === -1 || b === estado.bioma;
const passaMes = (m) => estado.mes === 0 || m === estado.mes;

function totalMeta(ano, meses) {
  let soma = 0;
  meses.forEach((m) => {
    const i = meta.meses.indexOf(`${ano}-${String(m).padStart(2, "0")}`);
    if (i < 0) return;
    meta.mensal_por_bioma[i].forEach((focos, b) => { if (passaBioma(b)) soma += focos; });
  });
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
  const passa = (i) => passaMes(f.mes[i]) && passaBioma(f.bioma[i]);

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
        `Foco em <strong>${dataDoFoco(ano, f.dia[object])}</strong><br>${meta.biomas[f.bioma[object]]}`, x, y),
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

function focosMunicipio(serie, ano, meses) {
  let soma = 0;
  for (let i = 0; i < serie.length; i += 3) {
    const aaaamm = serie[i];
    if (Math.floor(aaaamm / 100) === ano && meses.includes(aaaamm % 100) && passaBioma(serie[i + 1])) {
      soma += serie[i + 2];
    }
  }
  return soma;
}

async function camadaMun() {
  const [geo, series] = await municipios();
  const meses = estado.mes === 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [estado.mes];
  const focos = new Map();
  for (const id in series) {
    const f = focosMunicipio(series[id], estado.ano, meses);
    if (f) focos.set(Number(id), f);
  }
  cache.focosMun = focos;
  const max = percentil99([...focos.values()]);
  legenda(max, "por município");
  const chave = `${estado.ano}-${estado.mes}-${estado.bioma}-${estado.municipio?.id}`;
  return new deck.GeoJsonLayer({
    id: "mun",
    data: geo,
    getFillColor: (f) => cor(focos.get(f.properties.id), max, 215),
    getLineColor: (f) => (f.properties.id === estado.municipio?.id ? [255, 255, 255, 255] : [255, 255, 255, 22]),
    getLineWidth: (f) => (f.properties.id === estado.municipio?.id ? 2 : 0.4),
    lineWidthUnits: "pixels",
    stroked: true,
    pickable: true,
    updateTriggers: { getFillColor: chave, getLineColor: chave, getLineWidth: chave },
    onHover: ({ object, x, y }) => dica(object &&
      `<strong>${object.properties.nome} (${object.properties.uf})</strong><br>` +
      `${num.format(focos.get(object.properties.id) || 0)} focos`, x, y),
    onClick: ({ object }) => object && selecionarMunicipio(object.properties),
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

// --- painel ---------------------------------------------------------------

function mesesComparaveis() {
  const todos = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  if (estado.ano !== ultimo.ano) return estado.mes === 0 ? todos : [estado.mes];
  const fechado = ultimo.parcial ? ultimo.mes - 1 : ultimo.mes;
  if (estado.mes === 0) return todos.filter((m) => m <= fechado);
  return estado.mes <= fechado ? [estado.mes] : [];
}

function atualizarCards() {
  const meses = estado.mes === 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [estado.mes];
  const total = totalMeta(estado.ano, meses);
  const incluiParcial = estado.ano === ultimo.ano && ultimo.parcial && meses.includes(ultimo.mes);
  const periodo = estado.mes === 0 ? `${estado.ano}` : `${MESES_LONGOS[estado.mes - 1]} de ${estado.ano}`;
  $("rotulo-periodo").textContent = `Focos em ${periodo}` +
    (incluiParcial ? ` (até ${ultimo.dia}/${String(ultimo.mes).padStart(2, "0")})` : "");
  $("total").textContent = num.format(total);

  const variacao = $("variacao");
  variacao.className = "";
  const comparaveis = mesesComparaveis();
  const anterior = estado.ano - 1;
  if (!meta.meses.some((m) => m.startsWith(`${anterior}-`))) {
    $("rotulo-variacao").textContent = "sem ano anterior na série";
    variacao.textContent = "–";
    return;
  }
  if (!comparaveis.length) {
    $("rotulo-variacao").textContent = estado.mes > ultimo.mes ? "mês sem dado ainda" : "mês em andamento";
    variacao.textContent = "–";
    return;
  }
  const atual = totalMeta(estado.ano, comparaveis);
  const base = totalMeta(anterior, comparaveis);
  const recorte = comparaveis.length === 12 ? `${anterior}`
    : comparaveis.length === 1 ? `${MESES[comparaveis[0] - 1]}/${anterior}`
    : `${MESES[comparaveis[0] - 1]}–${MESES[comparaveis.at(-1) - 1]} de ${anterior}`;
  $("rotulo-variacao").textContent = `vs. ${recorte}`;
  if (!base) { variacao.textContent = "–"; return; }
  const pct = (atual / base - 1) * 100;
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
  const atual = MESES.map((_, i) => totalMeta(estado.ano, [i + 1]));
  const anterior = MESES.map((_, i) => totalMeta(estado.ano - 1, [i + 1]));
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
    const selecionado = estado.mes === 0 || estado.mes === i + 1;
    g.append(svg("rect", {
      x: x + passo * 0.22, y: base - hAt, width: passo * 0.56, height: hAt, rx: 2,
      fill: "var(--fogo-2)", opacity: selecionado ? 1 : 0.3,
    }));
    const rotulo = svg("text", { x: x + passo / 2, y: altura - 3, "text-anchor": "middle" });
    rotulo.textContent = nome[0].toUpperCase();
    g.append(rotulo);
    const titulo = svg("title", {});
    titulo.textContent = `${nome}/${estado.ano}: ${num.format(atual[i])} focos · ${nome}/${estado.ano - 1}: ${num.format(anterior[i])}`;
    g.append(titulo);
    g.addEventListener("click", () => { pararAnimacao(); estado.mes = estado.mes === i + 1 ? 0 : i + 1; atualizar(); });
    alvo.append(g);
  });
  $("leg-atual").textContent = estado.ano;
  $("leg-anterior").textContent = estado.ano - 1;
}

async function selecionarMunicipio(props) {
  estado.municipio = props;
  await atualizarMunicipio();
  desenharMapa();
}

async function atualizarMunicipio() {
  const caixa = $("municipio");
  if (!estado.municipio || estado.camada !== "mun") {
    caixa.hidden = true;
    $("dica-municipio").hidden = false;
    return;
  }
  const [, series] = await municipios();
  const { id, nome, uf } = estado.municipio;
  const serie = series[id] || [];
  const meses = estado.mes === 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [estado.mes];
  const focos = focosMunicipio(serie, estado.ano, meses);
  const posicao = [...cache.focosMun.values()].filter((f) => f > focos).length + 1;
  $("mun-nome").textContent = `${nome} (${uf})`;
  $("mun-resumo").innerHTML = focos
    ? `<strong>${num.format(focos)}</strong> focos no período · ${posicao}º do país`
    : "Nenhum foco no período selecionado.";

  const porMes = new Map();
  for (let i = 0; i < serie.length; i += 3) {
    if (passaBioma(serie[i + 1])) porMes.set(serie[i], (porMes.get(serie[i]) || 0) + serie[i + 2]);
  }
  const alvo = $("mun-serie");
  const largura = alvo.clientWidth || 300;
  const altura = alvo.clientHeight || 80;
  const valores = meta.meses.map((m) => porMes.get(Number(m.replace("-", ""))) || 0);
  const max = Math.max(1, ...valores);
  const passo = largura / valores.length;
  alvo.setAttribute("viewBox", `0 0 ${largura} ${altura}`);
  alvo.replaceChildren();
  valores.forEach((v, i) => {
    const doAno = meta.meses[i].startsWith(`${estado.ano}-`);
    const h = (v / max) * (altura - 2);
    alvo.append(svg("rect", {
      x: i * passo, y: altura - h, width: Math.max(1, passo - 1), height: h,
      fill: doAno ? "var(--fogo-2)" : "var(--anterior)",
    }));
  });
  $("mun-eixo").textContent = `${meta.meses[0].slice(0, 4)} a ${meta.meses.at(-1).slice(0, 4)} · máx. ${num.format(max)} focos/mês · em laranja, ${estado.ano}`;
  caixa.hidden = false;
  $("dica-municipio").hidden = true;
}

async function atualizar() {
  atualizarCards();
  desenharBarras();
  await desenharMapa();
  await atualizarMunicipio();
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
  estado.mes = 1;
  atualizar();
  $("play").textContent = "❚❚";
  animacao = setInterval(() => {
    if (estado.mes >= ultimoMes) { pararAnimacao(); return; }
    estado.mes += 1;
    atualizar();
  }, 1100);
}

// --- início ---------------------------------------------------------------

async function iniciar() {
  meta = await json("data/meta.json");
  ultimo = calcularUltimo();
  estado.ano = ultimo.ano;

  const anos = [...new Set(meta.meses.map((m) => Number(m.slice(0, 4))))].reverse();
  $("ano").append(...anos.map((a) => new Option(a, a)));
  $("bioma").append(...meta.biomas.slice(0, -1).map((b, i) => new Option(b, i)));
  $("atualizado").textContent =
    `dados até ${new Date(meta.ultimo_foco_gmt + "Z").toLocaleDateString("pt-BR", { timeZone: "UTC" })}`;

  $("ano").addEventListener("change", (e) => { pararAnimacao(); estado.ano = Number(e.target.value); estado.mes = 0; atualizar(); });
  $("bioma").addEventListener("change", (e) => { estado.bioma = Number(e.target.value); atualizar(); });
  $("play").addEventListener("click", animar);
  $("mun-fechar").addEventListener("click", () => { estado.municipio = null; atualizar(); });
  document.querySelectorAll(".camada button").forEach((botao) => botao.addEventListener("click", () => {
    estado.camada = botao.dataset.camada;
    document.querySelectorAll(".camada button").forEach((b) => {
      b.classList.toggle("ativo", b === botao);
      b.setAttribute("aria-checked", b === botao);
    });
    atualizar();
  }));

  const celular = matchMedia("(max-width: 720px)").matches;
  mapa = new maplibregl.Map({
    container: "mapa",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    bounds: BRASIL,
    fitBoundsOptions: { padding: celular ? { top: 20, bottom: innerHeight * 0.5, left: 10, right: 10 } : { top: 40, bottom: 40, left: 380, right: 40 } },
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

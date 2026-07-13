let API_KEY = localStorage.getItem("dashboard_api_key");

if (!API_KEY) {
  API_KEY = prompt("Digite a chave interna do dashboard:");
  if (API_KEY) localStorage.setItem("dashboard_api_key", API_KEY);
}

const SERIES = ["#3987e5", "#1baf7a", "#c98500", "#1f9e1f", "#9085e9", "#e66767", "#d55181", "#d95926"];
const BRAND = "#f4c400";

let graficoAvaliacoes;
let graficoNotificacoes;
let graficoTendenciaConsultas;
let graficoTendenciaAvaliacoes;

function formatarData(data) {
  if (!data) return "-";
  return new Date(data).toLocaleString("pt-BR");
}

function criarBadgeStatus(status) {
  if (status === "encontrado") return `<span class="badge badge-ok">Encontrado</span>`;
  if (status === "pago") return `<span class="badge badge-pago">Pago ✅</span>`;
  return `<span class="badge badge-erro">Não encontrado</span>`;
}

function criarBadgeTipo(tipo) {
  return `<span class="tipo-badge">${tipo || "-"}</span>`;
}

function hojeISO() {
  // Ajusta para horário de Brasília (UTC-3) — igual ao servidor
  const agora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const ano = agora.getUTCFullYear();
  const mes = String(agora.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(agora.getUTCDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function diaISOAtras(n) {
  const agora = new Date(Date.now() - 3 * 60 * 60 * 1000 - n * 86400000);
  const ano = agora.getUTCFullYear();
  const mes = String(agora.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(agora.getUTCDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function ultimosNDias(n) {
  const dias = [];
  for (let i = n - 1; i >= 0; i--) dias.push(diaISOAtras(i));
  return dias;
}

function rotuloDiaCurto(iso) {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

function getDataFiltro() {
  const input = document.getElementById("filtroData");
  return input?.value || hojeISO();
}

function mesmaData(item, dataFiltro) {
  return String(item?.data || "").startsWith(dataFiltro);
}

function contarPorTipo(notificacoes) {
  return notificacoes.reduce((acc, n) => {
    const tipo = n.tipo || "outros";
    acc[tipo] = (acc[tipo] || 0) + 1;
    return acc;
  }, {});
}

function atualizarCardsNotificacoesDoDia() {
  // Mantido só pra compatibilidade — os 6 cards de tipo foram consolidados
  // no gráfico "Notificações por tipo" pra reduzir ruído visual.
}

async function apiGet(url) {
  const resposta = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!resposta.ok) throw new Error("Erro ao carregar " + url);
  return resposta.json();
}

function calcularDelta(hoje, ontem) {
  if (ontem === 0 && hoje === 0) return { texto: "sem variação", classe: "flat" };
  if (ontem === 0) return { texto: `+${hoje} vs ontem`, classe: "up" };
  const diff = hoje - ontem;
  const pct = Math.round((diff / ontem) * 100);
  if (diff === 0) return { texto: "igual a ontem", classe: "flat" };
  const seta = diff > 0 ? "▲" : "▼";
  return { texto: `${seta} ${Math.abs(pct)}% vs ontem`, classe: diff > 0 ? "up" : "down" };
}

function renderizarDelta(elId, hoje, ontem) {
  const el = document.getElementById(elId);
  if (!el) return;
  const { texto, classe } = calcularDelta(hoje, ontem);
  el.textContent = texto;
  el.className = `card-delta ${classe}`;
}

// =============================================================================
// STATUS OPERACIONAL
// =============================================================================
async function carregarStatus() {
  try {
    const status = await apiGet("/dashboard/status");
    const topbar = document.getElementById("topbarStatus");

    const chatwoot = status.chatwootAtivo;
    const chatAvseg = status.chatAvsegAtivo;
    const testMode = status.testMode;

    topbar.innerHTML = `
      <span class="status-pill ${chatwoot ? "ok" : "off"}"><span class="status-dot"></span>Chatwoot <strong>${chatwoot ? "ON" : "OFF"}</strong></span>
      <span class="status-pill ${chatAvseg ? "ok" : "off"}"><span class="status-dot"></span>chat-avseg <strong>${chatAvseg ? "ON" : "OFF"}</strong></span>
      <span class="status-pill ${testMode ? "warn" : "ok"}"><span class="status-dot"></span>${testMode ? "Modo de teste" : "Produção"}</span>
      <span class="status-pill ok"><span class="status-dot"></span>Bot online</span>
    `;

    document.getElementById("opChatwoot").textContent = chatwoot ? "Ativo" : "Desligado";
    document.getElementById("opChatAvseg").textContent = chatAvseg ? "Ativo" : "Desligado";
    document.getElementById("opTestMode").textContent = testMode ? "Ligado" : "Desligado";

    document.querySelectorAll("#tab-operacao .op-card")[0].querySelector(".status-dot").style.background = chatwoot ? "var(--status-good)" : "var(--muted)";
    document.querySelectorAll("#tab-operacao .op-card")[1].querySelector(".status-dot").style.background = chatAvseg ? "var(--status-good)" : "var(--muted)";
    document.querySelectorAll("#tab-operacao .op-card")[2].querySelector(".status-dot").style.background = testMode ? "var(--status-warning)" : "var(--status-good)";

    document.getElementById("modoHumanoAgora").textContent = status.modoHumanoTotal || 0;
  } catch (erro) {
    const topbar = document.getElementById("topbarStatus");
    topbar.innerHTML = `<span class="status-pill off"><span class="status-dot"></span>Não foi possível carregar o status</span>`;
  }
}

async function carregarModoHumano() {
  const container = document.getElementById("listaModoHumano");
  try {
    const dados = await apiGet("/modo-humano");
    const numeros = dados.numeros || [];
    if (!numeros.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div>Nenhum associado aguardando atendimento humano agora.</div>`;
      return;
    }
    container.innerHTML = numeros.map((n) => `
      <div class="humano-item"><span>${n}</span><strong>Aguardando atendente</strong></div>
    `).join("");
  } catch (_) {
    container.innerHTML = `<div class="empty-state">Erro ao carregar.</div>`;
  }
}

function rotuloOrigemCanal(origem) {
  if (origem === "chatwoot") return "Chatwoot";
  if (origem === "meta") return "WhatsApp direto";
  return origem || "-";
}

async function carregarCanais() {
  const container = document.getElementById("listaCanais");
  try {
    const dados = await apiGet("/canais");
    const entradas = Object.entries(dados.canais || {});
    if (!entradas.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div>Nenhum canal registrado ainda.</div>`;
      return;
    }
    container.innerHTML = entradas.slice(0, 50).map(([numero, info]) => `
      <div class="canal-item"><span>${numero}</span><span class="tipo-badge">${rotuloOrigemCanal(info?.origem)}</span></div>
    `).join("");
  } catch (_) {
    container.innerHTML = `<div class="empty-state">Erro ao carregar.</div>`;
  }
}

async function carregarOptout() {
  const tbody = document.getElementById("optoutTabela");
  try {
    const lista = await apiGet("/dashboard/optout");
    document.getElementById("optoutTotal").textContent = Array.isArray(lista) ? lista.length : 0;
    if (!tbody) return;
    if (!lista.length) {
      tbody.innerHTML = `<tr><td class="empty-state">Nenhum opt-out registrado.</td></tr>`;
      return;
    }
    tbody.innerHTML = lista.map((telefone) => `<tr><td>${telefone}</td></tr>`).join("");
  } catch (_) {
    if (tbody) tbody.innerHTML = `<tr><td class="empty-state">Erro ao carregar.</td></tr>`;
  }
}

// =============================================================================
// RESUMO
// =============================================================================
let consultasCacheGlobal = [];
let notificacoesCacheGlobal = [];
let avaliacoesCacheGlobal = [];

async function carregarResumo() {
  const resumo = await apiGet("/dashboard/resumo");
  document.getElementById("avaliacoesHoje").textContent = resumo.avaliacoesHoje || 0;
  document.getElementById("mediaAvaliacoes").textContent = resumo.mediaAvaliacoes || "0.0";
  document.getElementById("consultasHoje").textContent = resumo.consultasHoje || 0;
  document.getElementById("boletosHoje").textContent = resumo.boletosEncontradosHoje || 0;
  document.getElementById("notificacoesHoje").textContent = resumo.notificacoesHoje || 0;
  document.getElementById("enviosRegistrados").textContent = resumo.enviosRegistrados || 0;
}

function montarGraficoTendencia(canvasId, chartRefSetter, chartRefGetter, dias, valores, cor, rotulo) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const atual = chartRefGetter();
  if (atual) atual.destroy();

  const grafico = new Chart(ctx, {
    type: "line",
    data: {
      labels: dias.map(rotuloDiaCurto),
      datasets: [{
        label: rotulo,
        data: valores,
        borderColor: cor,
        backgroundColor: cor + "22",
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: cor,
        pointBorderColor: "#1a1a20",
        pointBorderWidth: 1.5,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1e1e26",
          borderColor: "#2a2a33",
          borderWidth: 1,
          titleColor: "#f5f5f7",
          bodyColor: "#b9b9c1",
          padding: 10,
        },
      },
      scales: {
        x: { ticks: { color: "#86868f" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#86868f", precision: 0 }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    },
  });
  chartRefSetter(grafico);
}

function montarTendenciaConsultas() {
  const dias = ultimosNDias(7);
  const valores = dias.map((dia) => consultasCacheGlobal.filter((c) => mesmaData(c, dia)).length);
  montarGraficoTendencia(
    "graficoTendenciaConsultas",
    (g) => (graficoTendenciaConsultas = g),
    () => graficoTendenciaConsultas,
    dias, valores, "#3987e5", "Consultas",
  );
}

function montarTendenciaAvaliacoes() {
  const dias = ultimosNDias(7);
  const valores = dias.map((dia) => {
    const doDia = avaliacoesCacheGlobal.filter((a) => mesmaData(a, dia));
    if (!doDia.length) return 0;
    const soma = doDia.reduce((s, a) => s + Number(a.nota || 0), 0);
    return Number((soma / doDia.length).toFixed(2));
  });
  montarGraficoTendencia(
    "graficoTendenciaAvaliacoes",
    (g) => (graficoTendenciaAvaliacoes = g),
    () => graficoTendenciaAvaliacoes,
    dias, valores, BRAND, "Nota média",
  );
}

function montarGraficoAvaliacoes(avaliacoes) {
  const contagem = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  avaliacoes.forEach((a) => {
    const nota = Number(a.nota);
    if (contagem[nota] !== undefined) contagem[nota] += 1;
  });

  const ctx = document.getElementById("graficoAvaliacoes");
  if (!ctx) return;
  if (graficoAvaliacoes) graficoAvaliacoes.destroy();

  graficoAvaliacoes = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["1 ★", "2 ★", "3 ★", "4 ★", "5 ★"],
      datasets: [{
        label: "Quantidade de avaliações",
        data: [contagem[1], contagem[2], contagem[3], contagem[4], contagem[5]],
        backgroundColor: BRAND,
        borderRadius: 6,
        maxBarThickness: 46,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: "#1e1e26", borderColor: "#2a2a33", borderWidth: 1 },
      },
      scales: {
        x: { ticks: { color: "#86868f" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#86868f", precision: 0 }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    },
  });
}

async function carregarAvaliacoes() {
  const avaliacoes = await apiGet("/dashboard/avaliacoes");
  avaliacoesCacheGlobal = avaliacoes;
  const tbody = document.getElementById("avaliacoesTabela");
  if (tbody) {
    if (!avaliacoes.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Nenhuma avaliação registrada ainda.</td></tr>`;
    } else {
      tbody.innerHTML = avaliacoes.map((a) => `
        <tr>
          <td>${formatarData(a.data)}</td>
          <td>${a.telefone || "-"}</td>
          <td><span class="tipo-badge">${a.nota || "-"} ★</span></td>
          <td>${a.origem || "-"}</td>
        </tr>
      `).join("");
    }
  }
  montarGraficoAvaliacoes(avaliacoes);
  montarTendenciaAvaliacoes();
}

async function carregarConsultas() {
  const consultas = await apiGet("/dashboard/consultas");
  consultasCacheGlobal = consultas;
  const tbody = document.getElementById("consultasTabela");

  document.getElementById("totalConsultas").textContent = consultas.length;
  document.getElementById("consultasI9").textContent = consultas.filter((c) => c.sistema === "i9").length;
  document.getElementById("consultasSouth").textContent = consultas.filter((c) => c.sistema === "south").length;

  const hoje = hojeISO();
  const ontem = diaISOAtras(1);
  const consultasHoje = consultas.filter((c) => mesmaData(c, hoje)).length;
  const consultasOntem = consultas.filter((c) => mesmaData(c, ontem)).length;
  renderizarDelta("deltaConsultas", consultasHoje, consultasOntem);

  const encontradasHoje = consultas.filter((c) => mesmaData(c, hoje) && c.status === "encontrado").length;
  const encontradasOntem = consultas.filter((c) => mesmaData(c, ontem) && c.status === "encontrado").length;
  renderizarDelta("deltaBoletos", encontradasHoje, encontradasOntem);

  if (!consultas.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Nenhuma consulta registrada ainda.</td></tr>`;
  } else {
    tbody.innerHTML = consultas.slice(0, 200).map((c) => `
      <tr>
        <td>${formatarData(c.data)}</td>
        <td>${c.telefone || "-"}</td>
        <td>${c.entrada || "-"}</td>
        <td>${(c.sistema || "-").toUpperCase()}</td>
        <td>${criarBadgeStatus(c.status)}</td>
      </tr>
    `).join("");
  }

  montarTendenciaConsultas();
}

function montarGraficoNotificacoes(notificacoes) {
  const chavesTipo = ["lembrete_5", "lembrete_2", "cobranca_3", "cobranca_4", "cobranca_15", "aniversario"];
  const contagem = { lembrete_5: 0, lembrete_2: 0, cobranca_3: 0, cobranca_4: 0, cobranca_15: 0, aniversario: 0 };
  notificacoes.forEach((n) => { if (contagem[n.tipo] !== undefined) contagem[n.tipo] += 1; });

  const labels = ["Lembrete 5d", "Lembrete 2d", "Pendência 3d", "Pendência 4d", "Pendência 15d", "Aniversário"];
  const valores = chavesTipo.map((k) => contagem[k]);
  const cores = chavesTipo.map((_, i) => SERIES[i % SERIES.length]);

  const ctx = document.getElementById("graficoNotificacoes");
  if (graficoNotificacoes) graficoNotificacoes.destroy();

  graficoNotificacoes = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Quantidade",
        data: valores,
        backgroundColor: cores,
        borderRadius: 6,
        maxBarThickness: 54,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: "#1e1e26", borderColor: "#2a2a33", borderWidth: 1 },
      },
      scales: {
        x: { ticks: { color: "#86868f" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#86868f", precision: 0 }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
    },
  });
}

async function carregarNotificacoes() {
  const notificacoes = await apiGet("/dashboard/notificacoes");
  notificacoesCacheGlobal = notificacoes;
  const tbody = document.getElementById("notificacoesTabela");
  const dataFiltro = getDataFiltro();
  const notificacoesDoDia = notificacoes.filter((n) => mesmaData(n, dataFiltro));

  document.getElementById("totalNotificacoes").textContent = notificacoes.length;
  const notificacoesHojeEl = document.getElementById("notificacoesHoje");
  const hoje = hojeISO();
  const ontem = diaISOAtras(1);
  const notifHoje = notificacoes.filter((n) => mesmaData(n, hoje)).length;
  const notifOntem = notificacoes.filter((n) => mesmaData(n, ontem)).length;
  if (notificacoesHojeEl) notificacoesHojeEl.textContent = notifHoje;
  renderizarDelta("deltaNotificacoes", notifHoje, notifOntem);

  if (tbody) {
    if (!notificacoesDoDia.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Nenhuma notificação nessa data.</td></tr>`;
    } else {
      tbody.innerHTML = notificacoesDoDia.map((n) => `
        <tr>
          <td>${(n.sistema || "-").toUpperCase()}</td>
          <td>${formatarData(n.data)}</td>
          <td>${n.nome || "-"}</td>
          <td>${n.telefone || "-"}</td>
          <td>${criarBadgeTipo(n.tipo || "-")}</td>
          <td>${n.placa || "-"}</td>
          <td>${n.vencimento || "-"}</td>
        </tr>
      `).join("");
    }
  }

  montarGraficoNotificacoes(notificacoesDoDia);
}

// =============================================================================
// MINI CHAT
// =============================================================================
let conversasCache = [];
let telefoneSelecionado = null;
let buscaConversaAtual = "";

function classeOrigem(origem) {
  if (origem === "bot" || origem === "bot_ia") return "chat-bot";
  if (origem === "atendente") return "chat-atendente";
  return "chat-cliente";
}

function labelOrigem(origem) {
  if (origem === "bot") return "Bot";
  if (origem === "bot_ia") return "Bot IA";
  if (origem === "atendente") return "Atendente";
  if (origem === "cliente") return "Associado";
  if (origem === "status") return "Status";
  return origem || "-";
}

function renderizarMidia(m) {
  if (!m.mediaUrl) return "";

  if (m.mimeType?.startsWith("image/")) {
    return `
      <div class="chat-media">
        <a href="${m.mediaUrl}" target="_blank" rel="noopener noreferrer">
          <img src="${m.mediaUrl}" alt="${m.filename || "imagem"}" title="Clique para abrir" />
        </a>
      </div>
    `;
  }
  if (m.mimeType?.startsWith("audio/")) {
    return `<div class="chat-media"><audio controls src="${m.mediaUrl}"></audio></div>`;
  }
  if (m.mimeType?.startsWith("video/")) {
    return `<div class="chat-media"><video controls src="${m.mediaUrl}"></video></div>`;
  }
  return `
    <div class="chat-file">
      📎 <a href="${m.mediaUrl}" target="_blank">${m.filename || "Abrir anexo"}</a>
    </div>
  `;
}

function renderizarStatus(status) {
  if (!status) return "";
  if (status === "sent") return `<div class="msg-status">✔ Enviado</div>`;
  if (status === "delivered") return `<div class="msg-status">✔✔ Entregue</div>`;
  if (status === "read") return `<div class="msg-status read">✔✔ Visto</div>`;
  if (status === "failed") return `<div class="msg-status failed">⚠️ Falhou</div>`;
  return "";
}

function renderizarTipoMensagem(m) {
  if (m.tipo === "template") {
    return `<div class="chat-template-badge">📋 Template: ${m.mensagem || "-"}</div>`;
  }
  return m.mensagem || "-";
}

function renderizarListaContatos() {
  const nomesPorTelefone = {};
  conversasCache.forEach((c) => {
    const telefone = c.telefone;
    if (!telefone) return;
    const nomeValido = c.nome && c.nome !== "Associado" && c.tipo !== "status";
    if (nomeValido) nomesPorTelefone[telefone] = c.nome;
  });

  const grupos = {};
  conversasCache
    .filter((c) => c.telefone && c.tipo !== "status")
    .forEach((c) => {
      const telefone = c.telefone;
      if (!grupos[telefone]) {
        grupos[telefone] = {
          telefone,
          nome: nomesPorTelefone[telefone] || c.nome || "Associado",
          ultimaData: c.data,
          ultimaMensagem: c.mensagem || "-",
        };
      }
      if (new Date(c.data) > new Date(grupos[telefone].ultimaData)) {
        grupos[telefone].ultimaData = c.data;
        grupos[telefone].ultimaMensagem = c.mensagem || "-";
      }
      if (nomesPorTelefone[telefone]) grupos[telefone].nome = nomesPorTelefone[telefone];
    });

  const termo = buscaConversaAtual.toLowerCase();
  const lista = Object.values(grupos)
    .filter((c) => !termo || c.nome.toLowerCase().includes(termo) || c.telefone.includes(termo))
    .sort((a, b) => new Date(b.ultimaData) - new Date(a.ultimaData));

  const chatLista = document.getElementById("chatLista");
  if (!chatLista) return;

  if (!lista.length) {
    chatLista.innerHTML = `<div class="empty-state">Nenhuma conversa encontrada.</div>`;
    return;
  }

  chatLista.innerHTML = lista.map((c) => `
    <div class="chat-contact ${telefoneSelecionado === c.telefone ? "active" : ""}" onclick="abrirConversa('${c.telefone}')">
      <strong>${c.nome}</strong>
      <span>${c.telefone}</span>
      <span class="ultima-msg">${String(c.ultimaMensagem).slice(0, 40)}${c.ultimaMensagem?.length > 40 ? "..." : ""}</span>
    </div>
  `).join("");

  if (!telefoneSelecionado && lista.length > 0) {
    abrirConversa(lista[0].telefone);
  } else if (telefoneSelecionado) {
    abrirConversa(telefoneSelecionado);
  }
}

async function carregarConversas() {
  conversasCache = await apiGet("/dashboard/conversas");
  renderizarListaContatos();
}

function abrirConversa(telefone) {
  telefoneSelecionado = telefone;

  const mensagens = conversasCache
    .filter((c) => c.telefone === telefone && c.tipo !== "status")
    .sort((a, b) => new Date(a.data) - new Date(b.data));

  const nome = mensagens.find(
    (m) => m.nome && m.nome !== "Associado"
  )?.nome || "Associado";

  document.getElementById("chatHeader").textContent = `${nome} — ${telefone}`;

  const area = document.getElementById("chatMensagens");

  const statusPorMensagem = {};
  conversasCache.forEach((c) => {
    if (c.tipo === "status" && c.message_id) {
      statusPorMensagem[c.message_id] = c.mensagem;
    }
  });

  area.innerHTML = mensagens.map((m) => {
    const classe = classeOrigem(m.origem);
    const ehBot = m.origem === "bot" || m.origem === "bot_ia";
    const ehAtendente = m.origem === "atendente";

    return `
      <div class="chat-bubble ${classe}">
        <span class="chat-origem-label">${labelOrigem(m.origem)}</span>
        ${renderizarMidia(m)}
        <div class="chat-texto">${renderizarTipoMensagem(m)}</div>
        ${(ehBot || ehAtendente) ? renderizarStatus(statusPorMensagem[m.message_id] || m.status) : ""}
        <span class="chat-date">${formatarData(m.data)}</span>
      </div>
    `;
  }).join("");

  area.scrollTop = area.scrollHeight;

  document.querySelectorAll(".chat-contact").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".chat-contact").forEach((el) => {
    if (el.querySelector("span")?.textContent === telefone) el.classList.add("active");
  });
}

// =============================================================================
// INICIALIZAÇÃO
// =============================================================================
async function carregarTudo() {
  document.getElementById("ultimaAtualizacao").textContent =
    `Atualizado às ${new Date().toLocaleTimeString("pt-BR")} — atualização automática a cada 10s`;
  try {
    await Promise.all([
      carregarStatus(),
      carregarResumo(),
      carregarConsultas(),
      carregarNotificacoes(),
      carregarAvaliacoes(),
      carregarConversas(),
      carregarModoHumano(),
      carregarCanais(),
      carregarOptout(),
    ]);
  } catch (erro) {
    console.error(erro);
  }
}

function configurarAbas() {
  const botoes = document.querySelectorAll(".tab-btn");
  const conteudos = document.querySelectorAll(".tab-content");
  botoes.forEach((botao) => {
    botao.addEventListener("click", () => {
      const aba = botao.dataset.tab;
      botoes.forEach((b) => b.classList.remove("active"));
      conteudos.forEach((c) => c.classList.remove("active"));
      botao.classList.add("active");
      document.getElementById(`tab-${aba}`)?.classList.add("active");
    });
  });
}

function inicializarFiltroData() {
  const input = document.getElementById("filtroData");
  const botao = document.getElementById("btnAplicarData");
  if (input && !input.value) input.value = hojeISO();
  const atualizarComFiltro = () => {
    const doDia = notificacoesCacheGlobal.filter((n) => mesmaData(n, getDataFiltro()));
    const tbody = document.getElementById("notificacoesTabela");
    if (tbody) {
      tbody.innerHTML = !doDia.length
        ? `<tr><td colspan="7" class="empty-state">Nenhuma notificação nessa data.</td></tr>`
        : doDia.map((n) => `
            <tr>
              <td>${(n.sistema || "-").toUpperCase()}</td>
              <td>${formatarData(n.data)}</td>
              <td>${n.nome || "-"}</td>
              <td>${n.telefone || "-"}</td>
              <td>${criarBadgeTipo(n.tipo || "-")}</td>
              <td>${n.placa || "-"}</td>
              <td>${n.vencimento || "-"}</td>
            </tr>
          `).join("");
    }
    montarGraficoNotificacoes(doDia);
  };
  if (input) input.addEventListener("change", atualizarComFiltro);
  if (botao) botao.addEventListener("click", atualizarComFiltro);
}

function inicializarBuscaConversa() {
  const input = document.getElementById("buscaConversa");
  if (!input) return;
  input.addEventListener("input", (e) => {
    buscaConversaAtual = e.target.value;
    renderizarListaContatos();
  });
}

configurarAbas();
inicializarFiltroData();
inicializarBuscaConversa();
carregarTudo();
setInterval(carregarTudo, 10000);

let API_KEY = localStorage.getItem("dashboard_api_key");

if (!API_KEY) {
  API_KEY = prompt("Digite a chave interna do dashboard:");
  if (API_KEY) localStorage.setItem("dashboard_api_key", API_KEY);
}

let graficoAvaliacoes;
let graficoNotificacoes;

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

function atualizarCardsNotificacoesDoDia(notificacoesDoDia) {
  const resumo = contarPorTipo(notificacoesDoDia);
  const setText = (id, valor) => {
    const el = document.getElementById(id);
    if (el) el.textContent = valor || 0;
  };
  setText("aniversariosDia", resumo.aniversario);
  setText("lembrete5Dia", resumo.lembrete_5);
  setText("lembrete2Dia", resumo.lembrete_2);
  setText("cobranca3Dia", resumo.cobranca_3);
  setText("cobranca4Dia", resumo.cobranca_4);
  setText("cobranca15Dia", resumo.cobranca_15);
}

async function apiGet(url) {
  const resposta = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!resposta.ok) throw new Error("Erro ao carregar " + url);
  return resposta.json();
}

async function carregarResumo() {
  const resumo = await apiGet("/dashboard/resumo");
  document.getElementById("avaliacoesHoje").textContent = resumo.avaliacoesHoje || 0;
  document.getElementById("mediaAvaliacoes").textContent = resumo.mediaAvaliacoes || "0.0";
  document.getElementById("consultasHoje").textContent = resumo.consultasHoje || 0;
  document.getElementById("boletosHoje").textContent = resumo.boletosEncontradosHoje || 0;
  document.getElementById("notificacoesHoje").textContent = resumo.notificacoesHoje || 0;
  document.getElementById("optoutTotal").textContent = resumo.optoutTotal || 0;
  document.getElementById("enviosRegistrados").textContent = resumo.enviosRegistrados || 0;
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
      labels: ["1", "2", "3", "4", "5"],
      datasets: [{
        label: "Quantidade de avaliações",
        data: [contagem[1], contagem[2], contagem[3], contagem[4], contagem[5]],
        backgroundColor: ["#7a1f1f", "#a85c00", "#d39d00", "#e8b800", "#f4c400"],
        borderRadius: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#f5f5f5" } } },
      scales: {
        x: { ticks: { color: "#ddd" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { beginAtZero: true, ticks: { color: "#ddd", precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
      },
    },
  });
}

async function carregarAvaliacoes() {
  const avaliacoes = await apiGet("/dashboard/avaliacoes");
  const tbody = document.getElementById("avaliacoesTabela");
  if (tbody) {
    tbody.innerHTML = avaliacoes.map((a) => `
      <tr>
        <td>${formatarData(a.data)}</td>
        <td>${a.telefone || "-"}</td>
        <td><span class="tipo-badge">${a.nota || "-"}</span></td>
        <td>${a.origem || "-"}</td>
      </tr>
    `).join("");
  }
  montarGraficoAvaliacoes(avaliacoes);
}

async function carregarConsultas() {
  const consultas = await apiGet("/dashboard/consultas");
  const tbody = document.getElementById("consultasTabela");

  document.getElementById("totalConsultas").textContent = consultas.length;
  document.getElementById("consultasI9").textContent = consultas.filter((c) => c.sistema === "i9").length;
  document.getElementById("consultasSouth").textContent = consultas.filter((c) => c.sistema === "south").length;

  tbody.innerHTML = consultas.map((c) => `
    <tr>
      <td>${formatarData(c.data)}</td>
      <td>${c.telefone || "-"}</td>
      <td>${c.entrada || "-"}</td>
      <td>${(c.sistema || "-").toUpperCase()}</td>
      <td>${criarBadgeStatus(c.status)}</td>
    </tr>
  `).join("");
}

function montarGraficoNotificacoes(notificacoes) {
  const contagem = {
    lembrete_5: 0, lembrete_2: 0,
    cobranca_3: 0, cobranca_4: 0, cobranca_15: 0, aniversario: 0,
  };
  notificacoes.forEach((n) => {
    if (contagem[n.tipo] !== undefined) contagem[n.tipo] += 1;
  });

  const labels = ["Lembrete 5", "Lembrete 2", "Pendência 3", "Pendência 4", "Pendência 15", "Aniversário"];
  const valores = [
    contagem.lembrete_5, contagem.lembrete_2,
    contagem.cobranca_3, contagem.cobranca_4, contagem.cobranca_15, contagem.aniversario,
  ];

  const ctx = document.getElementById("graficoNotificacoes");
  if (graficoNotificacoes) graficoNotificacoes.destroy();

  graficoNotificacoes = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Quantidade",
        data: valores,
        backgroundColor: ["#f4c400", "#e8b800", "#d39d00", "#c48b00", "#bf8b00", "#ffd84d"],
        borderRadius: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#f5f5f5" } } },
      scales: {
        x: { ticks: { color: "#ddd" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { beginAtZero: true, ticks: { color: "#ddd", precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
      },
    },
  });
}

async function carregarNotificacoes() {
  const notificacoes = await apiGet("/dashboard/notificacoes");
  const tbody = document.getElementById("notificacoesTabela");
  const dataFiltro = getDataFiltro();
  const notificacoesDoDia = notificacoes.filter((n) => mesmaData(n, dataFiltro));

  document.getElementById("totalNotificacoes").textContent = notificacoes.length;
  const notificacoesHojeEl = document.getElementById("notificacoesHoje");
  if (notificacoesHojeEl) notificacoesHojeEl.textContent = notificacoesDoDia.length;

  atualizarCardsNotificacoesDoDia(notificacoesDoDia);

  if (tbody) {
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

  montarGraficoNotificacoes(notificacoesDoDia);
}

// =============================================================================
// MINI CHAT
// =============================================================================
let conversasCache = [];
let telefoneSelecionado = null;

function classeOrigem(origem) {
  if (origem === "bot" || origem === "bot_ia") return "chat-bot";
  if (origem === "atendente") return "chat-atendente";
  return "chat-cliente";
}

function labelOrigem(origem) {
  if (origem === "bot") return "Bot";
  if (origem === "bot_ia") return "Bot IA";
  if (origem === "atendente") return "Atendente";
  if (origem === "cliente") return "Cliente";
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

async function carregarConversas() {
  conversasCache = await apiGet("/dashboard/conversas");

  const nomesPorTelefone = {};
  conversasCache.forEach((c) => {
    const telefone = c.telefone;
    if (!telefone) return;
    const nomeValido = c.nome && c.nome !== "Cliente" && c.nome !== "Associado" && c.tipo !== "status";
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
          nome: nomesPorTelefone[telefone] || c.nome || "Cliente",
          ultimaData: c.data,
          ultimaMensagem: c.mensagem || "-",
          mensagens: [],
        };
      }
      grupos[telefone].mensagens.push(c);
      if (new Date(c.data) > new Date(grupos[telefone].ultimaData)) {
        grupos[telefone].ultimaData = c.data;
        grupos[telefone].ultimaMensagem = c.mensagem || "-";
      }
      if (nomesPorTelefone[telefone]) grupos[telefone].nome = nomesPorTelefone[telefone];
    });

  const lista = Object.values(grupos).sort((a, b) => new Date(b.ultimaData) - new Date(a.ultimaData));

  const chatLista = document.getElementById("chatLista");
  if (!chatLista) return;

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

function abrirConversa(telefone) {
  telefoneSelecionado = telefone;

  const mensagens = conversasCache
    .filter((c) => c.telefone === telefone && c.tipo !== "status")
    .sort((a, b) => new Date(a.data) - new Date(b.data));

  const nome = mensagens.find(
    (m) => m.nome && m.nome !== "Cliente" && m.nome !== "Associado"
  )?.nome || "Cliente";

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
  try {
    await carregarResumo();
    await carregarConsultas();
    await carregarNotificacoes();
    await carregarAvaliacoes();
    await carregarConversas();
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
  if (input) input.addEventListener("change", carregarTudo);
  if (botao) botao.addEventListener("click", carregarTudo);
}

configurarAbas();
inicializarFiltroData();
carregarTudo();
setInterval(carregarTudo, 10000);
let API_KEY = localStorage.getItem("dashboard_api_key");

if (!API_KEY) {
  API_KEY = prompt("Digite a chave interna do dashboard:");

  if (API_KEY) {
    localStorage.setItem("dashboard_api_key", API_KEY);
  }
}

let graficoAvaliacoes;
let graficoNotificacoes;

function formatarData(data) {
  if (!data) return "-";
  return new Date(data).toLocaleString("pt-BR");
}

function criarBadgeStatus(status) {
  const texto = status === "encontrado" ? "Encontrado" : "Não encontrado";
  const classe =
    status === "encontrado" ? "badge badge-ok" : "badge badge-erro";
  return `<span class="${classe}">${texto}</span>`;
}

function criarBadgeTipo(tipo) {
  return `<span class="tipo-badge">${tipo || "-"}</span>`;
}

async function apiGet(url) {
  const resposta = await fetch(url, {
    headers: {
      "x-api-key": API_KEY,
    },
  });

  if (!resposta.ok) {
    throw new Error("Erro ao carregar " + url);
  }

  return resposta.json();
}

async function carregarResumo() {
  const resumo = await apiGet("/dashboard/resumo");
  document.getElementById("avaliacoesHoje").textContent =
    resumo.avaliacoesHoje || 0;
  document.getElementById("mediaAvaliacoes").textContent =
    resumo.mediaAvaliacoes || "0.0";
  document.getElementById("consultasHoje").textContent =
    resumo.consultasHoje || 0;
  document.getElementById("boletosHoje").textContent =
    resumo.boletosEncontradosHoje || 0;
  document.getElementById("notificacoesHoje").textContent =
    resumo.notificacoesHoje || 0;
  document.getElementById("optoutTotal").textContent = resumo.optoutTotal || 0;
  document.getElementById("enviosRegistrados").textContent =
    resumo.enviosRegistrados || 0;
}
function montarGraficoAvaliacoes(avaliacoes) {
  const contagem = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };

  avaliacoes.forEach((a) => {
    const nota = Number(a.nota);
    if (contagem[nota] !== undefined) {
      contagem[nota] += 1;
    }
  });

  const ctx = document.getElementById("graficoAvaliacoes");
  if (!ctx) return;

  if (graficoAvaliacoes) {
    graficoAvaliacoes.destroy();
  }

  graficoAvaliacoes = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["1", "2", "3", "4", "5"],
      datasets: [
        {
          label: "Quantidade de avaliações",
          data: [
            contagem[1],
            contagem[2],
            contagem[3],
            contagem[4],
            contagem[5],
          ],
          backgroundColor: [
            "#7a1f1f",
            "#a85c00",
            "#d39d00",
            "#e8b800",
            "#f4c400",
          ],
          borderRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#f5f5f5",
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#ddd",
          },
          grid: {
            color: "rgba(255,255,255,0.06)",
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#ddd",
            precision: 0,
          },
          grid: {
            color: "rgba(255,255,255,0.06)",
          },
        },
      },
    },
  });
}

async function carregarAvaliacoes() {
  const avaliacoes = await apiGet("/dashboard/avaliacoes");
  const tbody = document.getElementById("avaliacoesTabela");

  if (tbody) {
    tbody.innerHTML = avaliacoes
      .map(
        (a) => `
        <tr>
          <td>${formatarData(a.data)}</td>
          <td>${a.telefone || "-"}</td>
          <td><span class="tipo-badge">${a.nota || "-"}</span></td>
          <td>${a.origem || "-"}</td>
        </tr>
      `
      )
      .join("");
  }

  montarGraficoAvaliacoes(avaliacoes);
}
async function carregarConsultas() {
  const consultas = await apiGet("/dashboard/consultas");
  const tbody = document.getElementById("consultasTabela");

  document.getElementById("totalConsultas").textContent = consultas.length;
  document.getElementById("consultasI9").textContent = consultas.filter(
    (c) => c.sistema === "i9",
  ).length;

  document.getElementById("consultasSouth").textContent = consultas.filter(
    (c) => c.sistema === "south",
  ).length;

  tbody.innerHTML = consultas
    .map(
      (c) => `
      <tr>
        <td>${formatarData(c.data)}</td>
        <td>${c.telefone || "-"}</td>
        <td>${c.entrada || "-"}</td>
        <td>${(c.sistema || "-").toUpperCase()}</td>
        <td>${criarBadgeStatus(c.status)}</td>
      </tr>
    `,
    )
    .join("");
}

function montarGraficoNotificacoes(notificacoes) {
  const contagem = {
    lembrete_5: 0,
    lembrete_2: 0,
    cobranca_4: 0,
    cobranca_15: 0,
    aniversario: 0,
  };

  notificacoes.forEach((n) => {
    if (contagem[n.tipo] !== undefined) {
      contagem[n.tipo] += 1;
    }
  });

  const labels = [
    "Lembrete 5",
    "Lembrete 2",
    "Pendência 4",
    "Pendência 15",
    "Aniversário",
  ];

  const valores = [
    contagem.lembrete_5,
    contagem.lembrete_2,
    contagem.cobranca_4,
    contagem.cobranca_15,
    contagem.aniversario,
  ];

  const ctx = document.getElementById("graficoNotificacoes");

  if (graficoNotificacoes) {
    graficoNotificacoes.destroy();
  }

  graficoNotificacoes = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Quantidade",
          data: valores,
          backgroundColor: [
            "#f4c400",
            "#e8b800",
            "#d39d00",
            "#bf8b00",
            "#ffd84d",
          ],
          borderRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#f5f5f5",
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#ddd",
          },
          grid: {
            color: "rgba(255,255,255,0.06)",
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#ddd",
            precision: 0,
          },
          grid: {
            color: "rgba(255,255,255,0.06)",
          },
        },
      },
    },
  });
}

async function carregarNotificacoes() {
  const notificacoes = await apiGet("/dashboard/notificacoes");
  const tbody = document.getElementById("notificacoesTabela");

  document.getElementById("totalNotificacoes").textContent =
    notificacoes.length;

  tbody.innerHTML = notificacoes
  .map(
    (n) => `
    <tr>
      <td>${(n.sistema || "-").toUpperCase()}</td>
      <td>${formatarData(n.data)}</td>
      <td>${n.nome || "-"}</td>
      <td>${n.telefone || "-"}</td>
      <td>${criarBadgeTipo(n.tipo || "-")}</td>
      <td>${n.placa || "-"}</td>
      <td>${n.vencimento || "-"}</td>
    </tr>
  `,
)
.join("");

  montarGraficoNotificacoes(notificacoes);
}
let conversasCache = [];
let telefoneSelecionado = null;

async function carregarConversas() {
  conversasCache = await apiGet("/dashboard/conversas");

  const grupos = {};

  conversasCache.forEach((c) => {
    const telefone = c.telefone || "sem_telefone";

    if (!grupos[telefone]) {
      grupos[telefone] = {
        telefone,
        nome: c.nome || "Cliente",
        ultimaData: c.data,
        ultimaMensagem: c.mensagem || "-",
        mensagens: [],
      };
    }

    grupos[telefone].mensagens.push(c);

    if (new Date(c.data) > new Date(grupos[telefone].ultimaData)) {
      grupos[telefone].ultimaData = c.data;
      grupos[telefone].ultimaMensagem = c.mensagem || "-";
      grupos[telefone].nome = c.nome || grupos[telefone].nome;
    }
  });

  const lista = Object.values(grupos).sort(
    (a, b) => new Date(b.ultimaData) - new Date(a.ultimaData)
  );

  const chatLista = document.getElementById("chatLista");
  if (!chatLista) return;

  chatLista.innerHTML = lista
    .map(
      (c) => `
      <div class="chat-contact ${telefoneSelecionado === c.telefone ? "active" : ""}" onclick="abrirConversa('${c.telefone}')">
        <strong>${c.nome}</strong>
        <span>${c.telefone}</span><br>
        <span>${c.ultimaMensagem}</span>
      </div>
    `
    )
    .join("");

  if (!telefoneSelecionado && lista.length > 0) {
    abrirConversa(lista[0].telefone);
  } else if (telefoneSelecionado) {
    abrirConversa(telefoneSelecionado);
  }
}
function renderizarStatus(status) {
  if (!status) return "";

  if (status === "sent") {
    return `<div class="msg-status">✔</div>`;
  }

  if (status === "delivered") {
    return `<div class="msg-status">✔✔</div>`;
  }

  if (status === "read") {
    return `<div class="msg-status read">✔✔</div>`;
  }

  if (status === "failed") {
    return `<div class="msg-status failed">⚠️ falhou</div>`;
  }

  return "";
}
function abrirConversa(telefone) {
  telefoneSelecionado = telefone;

  const mensagens = conversasCache
  .filter((c) => c.telefone === telefone && c.tipo !== "status")
    .sort((a, b) => new Date(a.data) - new Date(b.data));

  const nome = mensagens[mensagens.length - 1]?.nome || "Cliente";

  document.getElementById("chatHeader").textContent = `${nome} - ${telefone}`;

 const area = document.getElementById("chatMensagens");

const statusPorMensagem = {};

conversasCache.forEach((c) => {
  if (c.tipo === "status" && c.message_id) {
    statusPorMensagem[c.message_id] = c.mensagem;
  }
});

area.innerHTML = mensagens  
    .map((m) => {
      const classe = m.origem === "bot" ? "chat-bot" : "chat-cliente";

      return `
        <div class="chat-bubble ${classe}">
          ${m.mensagem || "-"}
${m.origem === "bot"
  ? renderizarStatus(statusPorMensagem[m.message_id] || m.status)
  : ""}
          <span class="chat-date">${formatarData(m.data)} • ${m.origem || "-"}</span>
        </div>
      `;
    })
    .join("");

  area.scrollTop = area.scrollHeight;

  document.querySelectorAll(".chat-contact").forEach((el) => {
    el.classList.remove("active");
  });
}
async function carregarTudo() {
  try {
    await carregarResumo();
    await carregarConsultas();
    await carregarNotificacoes();
    await carregarAvaliacoes();
    await carregarConversas();
  } catch (erro) {
    alert("Erro ao carregar dashboard. Confira a chave interna.");
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

configurarAbas();

carregarTudo();
setInterval(carregarTudo, 10000);

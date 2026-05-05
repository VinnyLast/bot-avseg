const API_KEY = prompt("Digite a chave interna do dashboard:");

let graficoNotificacoes;

function formatarData(data) {
  if (!data) return "-";
  return new Date(data).toLocaleString("pt-BR");
}

function criarBadgeStatus(status) {
  const texto = status === "encontrado" ? "Encontrado" : "Não encontrado";
  const classe = status === "encontrado" ? "badge badge-ok" : "badge badge-erro";
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

  document.getElementById("consultasHoje").textContent = resumo.consultasHoje || 0;
  document.getElementById("boletosHoje").textContent = resumo.boletosEncontradosHoje || 0;
  document.getElementById("notificacoesHoje").textContent = resumo.notificacoesHoje || 0;
  document.getElementById("optoutTotal").textContent = resumo.optoutTotal || 0;
  document.getElementById("enviosRegistrados").textContent = resumo.enviosRegistrados || 0;
}

async function carregarConsultas() {
  const consultas = await apiGet("/dashboard/consultas");
  const tbody = document.getElementById("consultasTabela");

  document.getElementById("totalConsultas").textContent = consultas.length;
  document.getElementById("consultasI9").textContent =
    consultas.filter((c) => c.sistema === "i9").length;

  document.getElementById("consultasSouth").textContent =
    consultas.filter((c) => c.sistema === "south").length;

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
    `
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

  document.getElementById("totalNotificacoes").textContent = notificacoes.length;

  tbody.innerHTML = notificacoes
    .map(
      (n) => `
      <tr>
        <td>${formatarData(n.data)}</td>
        <td>${n.telefone || "-"}</td>
        <td>${criarBadgeTipo(n.tipo || "-")}</td>
        <td>${n.placa || "-"}</td>
        <td>${n.vencimento || "-"}</td>
      </tr>
    `
    )
    .join("");

  montarGraficoNotificacoes(notificacoes);
}

async function carregarTudo() {
  try {
    await carregarResumo();
    await carregarConsultas();
    await carregarNotificacoes();
  } catch (erro) {
    alert("Erro ao carregar dashboard. Confira a chave interna.");
    console.error(erro);
  }
}

carregarTudo();
setInterval(carregarTudo, 10000);
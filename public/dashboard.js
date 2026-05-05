const API_KEY = prompt("Digite a chave interna do dashboard:");

function formatarData(data) {
  if (!data) return "-";
  return new Date(data).toLocaleString("pt-BR");
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
}

async function carregarConsultas() {
  const consultas = await apiGet("/dashboard/consultas");
  const tbody = document.getElementById("consultasTabela");

  tbody.innerHTML = consultas
    .map(
      (c) => `
      <tr>
        <td>${formatarData(c.data)}</td>
        <td>${c.telefone || "-"}</td>
        <td>${c.entrada || "-"}</td>
        <td>${c.sistema || "-"}</td>
        <td>${c.status || "-"}</td>
      </tr>
    `
    )
    .join("");
}

async function carregarNotificacoes() {
  const notificacoes = await apiGet("/dashboard/notificacoes");
  const tbody = document.getElementById("notificacoesTabela");

  tbody.innerHTML = notificacoes
    .map(
      (n) => `
      <tr>
        <td>${formatarData(n.data)}</td>
        <td>${n.telefone || "-"}</td>
        <td>${n.tipo || "-"}</td>
        <td>${n.placa || "-"}</td>
        <td>${n.vencimento || "-"}</td>
      </tr>
    `
    )
    .join("");
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
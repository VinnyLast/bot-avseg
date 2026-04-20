require("dotenv").config();

const axios = require("axios");
const cron = require("node-cron");
const {
  app,
  enviarTexto,
  enviarImagem,
  normalizarTelefoneBR,
} = require("./api");

// =============================================================================
// CONFIGURAÇÕES
// =============================================================================
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:10000";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const DELAY_ENVIO_MS = Number(process.env.DELAY_ENVIO_MS || 3000);

const IMAGEM_BOAS_VINDAS =
  process.env.IMAGEM_URL ||
  "https://raw.githubusercontent.com/VinnyLast/bot-avseg/refs/heads/main/imagem.jpeg";

const TEST_MODE = process.env.TEST_MODE === "true";
const ENABLE_CRON = process.env.ENABLE_CRON === "true";

const ALLOWED_NUMBERS = new Set(
  String(process.env.ALLOWED_NUMBERS || "")
    .split(",")
    .map((n) => normalizarTelefoneBR(n))
    .filter(Boolean),
);

// Chatwoot
const CHATWOOT_ENABLED = process.env.CHATWOOT_ENABLED === "true";
const CHATWOOT_BASE_URL = String(process.env.CHATWOOT_BASE_URL || "").replace(
  /\/+$/,
  "",
);
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";

// Links
const LINK_COTACAO = process.env.LINK_COTACAO || "";
const LINK_VISTORIA = process.env.LINK_VISTORIA || "";

// Informações da empresa
const INSTAGRAM = "https://www.instagram.com/avsegauto/";
const LOCALIZACAO = "https://maps.app.goo.gl/EauXSA7CtM3Lxa5D8";
const TELEFONE_ASSISTENCIA = "0800 130-0078";

// =============================================================================
// ESTADO EM MEMÓRIA
// =============================================================================
const estadoUsuario = {};
const modoHumano = new Set();
const usuariosOptOut = new Set();
const avaliacoes = [];
const ultimoCanalPorNumero = Object.create(null);

// =============================================================================
// UTILITÁRIOS
// =============================================================================
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limparNumeros(texto) {
  return String(texto || "").replace(/\D/g, "");
}

function parecePlaca(texto) {
  const valor = String(texto || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace("-", "");
  return (
    /^[A-Z]{3}[0-9]{4}$/.test(valor) ||
    /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/.test(valor)
  );
}

function normalizarPlaca(texto) {
  return String(texto || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatarValor(valor) {
  if (valor === null || valor === undefined || valor === "" || valor === "ND")
    return "ND";
  const numero = Number(String(valor).replace(",", "."));
  if (Number.isNaN(numero)) return String(valor);
  return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarDataBR(data) {
  if (!data || data === "ND") return "ND";
  const texto = String(data);
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    const [ano, mes, dia] = texto.split("-");
    return `${dia}/${mes}/${ano}`;
  }
  return texto;
}

function existeLinhaDigitavel(v) {
  return Boolean(
    v?.linhadigitavel &&
    v.linhadigitavel !== "ND" &&
    String(v.linhadigitavel).trim() !== "",
  );
}

function existeBoletoDisponivel(v) {
  return Boolean(
    (v?.url && v.url !== "ND") ||
    (v?.linhadigitavel && v.linhadigitavel !== "ND") ||
    (v?.valor && v.valor !== "ND") ||
    (v?.vencimento && v.vencimento !== "ND"),
  );
}

function podeEnviar(numero) {
  const normalizado = normalizarTelefoneBR(numero);
  if (!normalizado) return false;
  if (!TEST_MODE) return true;
  return ALLOWED_NUMBERS.has(normalizado);
}

function axiosInterno() {
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: 20000,
    headers: {
      "x-api-key": INTERNAL_API_KEY,
      "Content-Type": "application/json",
    },
  });
}

function atualizarUltimoCanal(from, dados = {}) {
  const numero = normalizarTelefoneBR(from);
  if (!numero) return;
  ultimoCanalPorNumero[numero] = { ...ultimoCanalPorNumero[numero], ...dados };
}

function obterUltimoCanal(from) {
  const numero = normalizarTelefoneBR(from);
  if (!numero) return null;
  return ultimoCanalPorNumero[numero] || null;
}

function temChatwootConfigurado() {
  return Boolean(
    CHATWOOT_ENABLED &&
    CHATWOOT_BASE_URL &&
    CHATWOOT_API_TOKEN &&
    CHATWOOT_ACCOUNT_ID,
  );
}

function montarHeadersChatwoot() {
  return {
    api_access_token: CHATWOOT_API_TOKEN,
    "Content-Type": "application/json",
  };
}

// =============================================================================
// CHATWOOT — API
// =============================================================================
async function criarOuBuscarContatoChatwoot(telefone, nome = "Associado") {
  if (!temChatwootConfigurado()) return null;

  // Tenta encontrar contato existente
  try {
    const busca = await axios.get(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search`,
      {
        params: { q: telefone, page: 1 },
        headers: montarHeadersChatwoot(),
        timeout: 10000,
      },
    );
    const contatos = busca.data?.payload || [];
    if (contatos.length > 0) {
      console.log(`🔍 Contato encontrado no Chatwoot: ${contatos[0].id}`);
      return contatos[0].id;
    }
  } catch (_) {}

  // Cria novo contato
  try {
    const criado = await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
      { name: nome, phone_number: `+${telefone}` },
      { headers: montarHeadersChatwoot(), timeout: 10000 },
    );
    console.log(`✅ Contato criado no Chatwoot: ${criado.data?.id}`);
    return criado.data?.id;
  } catch (erro) {
    console.error(
      "❌ Erro ao criar contato:",
      erro.response?.data || erro.message,
    );
    return null;
  }
}

async function criarConversaChatwoot(telefone, nome = "Associado") {
  if (!temChatwootConfigurado()) return null;

  try {
    const contactId = await criarOuBuscarContatoChatwoot(telefone, nome);
    if (!contactId) return null;

    // Busca o inbox WhatsApp
    const inboxes = await axios.get(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes`,
      { headers: montarHeadersChatwoot(), timeout: 10000 },
    );

    const inbox = inboxes.data?.payload?.find((i) =>
      String(i.channel_type || "")
        .toLowerCase()
        .includes("whatsapp"),
    );

    if (!inbox) {
      console.error("❌ Inbox WhatsApp não encontrado no Chatwoot");
      return null;
    }

    const conversa = await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
      { inbox_id: inbox.id, contact_id: contactId, status: "open" },
      { headers: montarHeadersChatwoot(), timeout: 10000 },
    );

    const conversationId = conversa.data?.id;
    console.log(`✅ Conversa criada no Chatwoot: ${conversationId}`);
    return conversationId;
  } catch (erro) {
    console.error(
      "❌ Erro ao criar conversa:",
      erro.response?.data || erro.message,
    );
    return null;
  }
}

async function enviarTextoChatwoot(conversationId, texto, isPrivate = false) {
  if (!temChatwootConfigurado() || !conversationId) return;

  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

  const response = await axios.post(
    url,
    { content: texto, message_type: "outgoing", private: isPrivate },
    { headers: montarHeadersChatwoot(), timeout: 15000 },
  );

  console.log(
    `✅ TEXTO ENVIADO CHATWOOT conv=${conversationId}:`,
    response.data?.id || "ok",
  );
  return response.data;
}

async function abrirConversaHumanaChatwoot(conversationId) {
  if (!temChatwootConfigurado() || !conversationId) return;

  try {
    await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
      { status: "open" },
      { headers: montarHeadersChatwoot(), timeout: 15000 },
    );
    console.log(`👨‍💻 Conversa ${conversationId} aberta para humano no Chatwoot`);
  } catch (erro) {
    console.error(
      `❌ Erro ao abrir conversa humana:`,
      erro.response?.data || erro.message,
    );
  }
}

async function marcarConversaResolvidaChatwoot(conversationId) {
  if (!temChatwootConfigurado() || !conversationId) return;

  try {
    await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
      { status: "resolved" },
      { headers: montarHeadersChatwoot(), timeout: 15000 },
    );
    console.log(`✅ Conversa ${conversationId} resolvida no Chatwoot`);
  } catch (erro) {
    console.error(
      `❌ Erro ao resolver conversa:`,
      erro.response?.data || erro.message,
    );
  }
}

// =============================================================================
// CAMADA DE RESPOSTA POR CANAL
// =============================================================================
async function enviarTextoCanal(from, texto, contexto = {}) {
  const numero = normalizarTelefoneBR(from);
  if (!numero) return;
  if (!podeEnviar(numero)) {
    console.log(`🧪 TEST_MODE ativo: envio bloqueado para ${numero}`);
    return;
  }

  const origem = contexto.origem || obterUltimoCanal(numero)?.origem || "meta";

  try {
    if (origem === "chatwoot") {
      const conversationId =
        contexto.conversationId || obterUltimoCanal(numero)?.conversationId;
      if (!conversationId) {
        await enviarTexto(numero, texto);
        return;
      }
      await enviarTextoChatwoot(conversationId, texto);
      return;
    }
    await enviarTexto(numero, texto);
    console.log(`✅ Texto enviado para ${numero}`);
  } catch (erro) {
    console.error(
      `❌ Erro ao enviar texto para ${numero}:`,
      erro.response?.data || erro.message,
    );
  }
}

async function enviarImagemCanal(from, imageUrl, caption = "", contexto = {}) {
  const numero = normalizarTelefoneBR(from);

  if (!numero) return;

  if (!podeEnviar(numero)) return;

  try {
    // Envia imagem normal em qualquer canal
    await enviarImagem(numero, imageUrl, caption);

    console.log(`✅ Imagem enviada para ${numero}`);
  } catch (erro) {
    console.error("Erro enviando imagem:", erro.response?.data || erro.message);

    // fallback só se der erro de verdade
    if (caption) {
      await enviarTextoCanal(numero, caption, contexto);
    }
  }
}

// =============================================================================
// MENU
// =============================================================================
function montarOpcoesMenu() {
  return [
    `1️⃣ Cotação`,
    `2️⃣ Pagamentos`,
    `3️⃣ Acione assistência 24h`,
    `4️⃣ Vistoria do veículo`,
    `5️⃣ Falar com atendente`,
    `6️⃣ Avaliar atendimento`,
    `7️⃣ Encerrar conversa`,
  ].join("\n");
}

async function enviarMenu(numero, cliente, contexto = {}) {
  let saudacao = `🦁 *AVSEG Proteção Veicular*\n\n`;

  if (
    cliente &&
    !cliente.erro &&
    Array.isArray(cliente.veiculos) &&
    cliente.veiculos.length
  ) {
    saudacao += `Olá *${cliente.nome || "Associado"}*! 👋\n\n🚗 *Seus veículos:*\n\n`;
    cliente.veiculos.forEach((v, i) => {
      saudacao += `${i + 1}️⃣ Placa: ${v.placa || "ND"}\n📅 Vencimento: ${v.vencimento || "ND"}\n\n`;
    });
  } else {
    saudacao += `Olá! Seja bem-vindo(a)! 👋\n\n`;
  }

  saudacao += `Como posso te ajudar hoje?\n\n`;
  saudacao += montarOpcoesMenu();
  saudacao += `\n\n──────────────────\n`;
  saudacao += `📸 *Instagram:* ${INSTAGRAM}\n`;
  saudacao += `📍 *Localização:* ${LOCALIZACAO}\n`;
  saudacao += `⭐ *Google:* 4,7 — 63 avaliações\n`;
  saudacao += `\n_(Para parar notificações automáticas, responda *0*)_`;

  await enviarImagemCanal(numero, IMAGEM_BOAS_VINDAS, saudacao, contexto);
}

// =============================================================================
// MENSAGENS DE BOLETO
// =============================================================================
function montarResumoVeiculo(v, indice) {
  let msg = `💳 *Participação mensal ${indice + 1} encontrada:*\n\n`;
  msg += `👤 Associado: ${v.nome || "ND"}\n`;
  msg += `📋 Matrícula: ${v.matricula || "ND"}\n`;
  msg += `🚗 Placa: ${v.placa || "ND"}\n`;
  msg += `📅 Vencimento: ${formatarDataBR(v.vencimento)}\n`;
  msg += `💰 Valor: ${formatarValor(v.valor)}\n`;
  if (v.url && v.url !== "ND") msg += `🔗 Participação mensal: ${v.url}\n`;
  return msg;
}

// =============================================================================
// NOTIFICAÇÕES
// =============================================================================
function montarMensagemNotificacao(item) {
  const nome = item.nome || "Associado";
  const placa = item.placa || "ND";
  const valor = formatarValor(item.valor);
  const vencimento = formatarDataBR(item.vencimento);
  const temPlaca = placa !== "ND";
  const temValor = valor !== "ND";
  const temVenc = vencimento !== "ND";

  switch (item.tipo) {
    case "aniversario":
      return (
        `🎉 *Feliz aniversário, ${nome}!*\n\n` +
        `A AVSEG Proteção Veicular deseja muita saúde, sucesso e proteção para você e sua família.\n\n` +
        `Obrigado por confiar na nossa proteção! 🚗🛡️\n\n📍 ${LOCALIZACAO}`
      );
    case "lembrete_5":
      return (
        `Olá ${nome}! 🚗\n\n` +
        `Passando para lembrar que a participação mensal da sua proteção${temPlaca ? ` da placa *${placa}*` : ""} vence em *5 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nSe precisar da 2ª via, basta responder com *menu*.\n\n_(Para parar de receber lembretes, responda com *0*)_`
      );
    case "lembrete_2":
      return (
        `Atenção ${nome}! 🚨\n\n` +
        `Sua participação mensal${temPlaca ? ` da placa *${placa}*` : ""} vence em *2 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nJá está com ela em mãos? Responda *menu* para obter a 2ª via.\n\n_(Para parar de receber lembretes, responda com *0*)_`
      );
    case "vencimento_hoje":
      return (
        `🚨 *Vence hoje!*\n\n` +
        `${nome}, a sua participação mensal${temPlaca ? ` da placa *${placa}*` : ""} vence *hoje*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nEvite ficar sem cobertura. Se precisar da 2ª via, responda com *menu*.`
      );
    case "cobranca_atraso":
      return (
        `⚠️ *Aviso de pendência*\n\n` +
        `${nome}, identificamos que a participação mensal${temPlaca ? ` da placa *${placa}*` : ""} venceu há *2 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento original: *${vencimento}*\n` : "") +
        `\nRegularize para manter sua proteção ativa. Responda *menu* e acesse *Pagamentos*.`
      );
    default:
      return "";
  }
}

// =============================================================================
// FLUXO DE AVALIAÇÃO
// =============================================================================
async function iniciarAvaliacao(from, contexto = {}) {
  estadoUsuario[from] = "avaliacao";
  await enviarTextoCanal(
    from,
    `⭐ *Avalie nosso atendimento!*\n\nResponda com um número de *1 a 5*:\n\n1️⃣ — Ruim\n2️⃣ — Regular\n3️⃣ — Bom\n4️⃣ — Ótimo\n5️⃣ — Excelente 😍`,
    contexto,
  );
}

async function processarAvaliacao(from, texto, contexto = {}) {
  const nota = parseInt(texto, 10);

  if (isNaN(nota) || nota < 1 || nota > 5) {
    await enviarTextoCanal(
      from,
      `❌ Nota inválida. Por favor, responda com um número de *1 a 5*.`,
      contexto,
    );
    return;
  }

  const estrelas = "⭐".repeat(nota);
  avaliacoes.push({
    telefone: from,
    nota,
    data: new Date().toISOString(),
    origem: contexto.origem || "meta",
  });
  console.log(`📊 Avaliação registrada: ${from} — nota ${nota}/5`);

  const mensagemNota = {
    1: `Lamentamos pela experiência. Vamos trabalhar para melhorar! 🙏`,
    2: `Obrigado pelo feedback. Estamos empenhados em melhorar! 💪`,
    3: `Boa! Queremos sempre evoluir. Obrigado pela avaliação! 😊`,
    4: `Ótimo! Fico feliz que tenha gostado do atendimento! 🤩`,
    5: `Incrível! Sua satisfação é tudo para nós! 🥰🚗🛡️`,
  };

  estadoUsuario[from] = null;
  await enviarTextoCanal(
    from,
    `${estrelas}\n\n*Nota ${nota}/5* — ${mensagemNota[nota]}\n\nSe precisar de algo mais, estamos à disposição. Digite *menu* a qualquer momento.`,
    contexto,
  );
}

// =============================================================================
// FLUXO DE PAGAMENTO
// =============================================================================
async function processarPagamento(from, bodyText, contexto = {}) {
  const http = axiosInterno();
  const somenteNumeros = limparNumeros(bodyText);
  let payload = { tipo: 2, cpf: "", cnpj: "", placa: "" };

  if (parecePlaca(bodyText)) {
    payload.tipo = 1;
    payload.placa = normalizarPlaca(bodyText);
  } else if (somenteNumeros.length === 11) {
    payload.tipo = 2;
    payload.cpf = somenteNumeros;
  } else if (somenteNumeros.length === 14) {
    payload.tipo = 3;
    payload.cnpj = somenteNumeros;
  } else {
    await enviarTextoCanal(
      from,
      "❌ Envie uma placa, CPF (11 dígitos) ou CNPJ (14 dígitos) válido.",
      contexto,
    );
    return;
  }

  try {
    let dados;
    try {
      const resposta = await http.post("/boleto", payload);
      dados = resposta.data;
    } catch (erroApi) {
      dados = erroApi.response?.data;
      if (!dados) {
        await enviarTextoCanal(
          from,
          "❌ Não consegui consultar sua participação mensal agora. Tente novamente em instantes.",
          contexto,
        );
        estadoUsuario[from] = null;
        return;
      }
    }

    if (dados?.status === "sucesso" && dados?.mensagemWhatsapp) {
      await enviarTextoCanal(from, dados.mensagemWhatsapp, contexto);

      const veiculosComLinha = Array.isArray(dados.veiculos)
        ? dados.veiculos.filter(existeLinhaDigitavel)
        : [];
      for (const v of veiculosComLinha) {
        await delay(500);
        await enviarTextoCanal(
          from,
          String(v.linhadigitavel).replace(/\s+/g, ""),
          contexto,
        );
      }

      await delay(500);
      await enviarTextoCanal(
        from,
        "Digite *menu* para voltar ao início ou *7* para encerrar.",
        contexto,
      );
      estadoUsuario[from] = null;
      return;
    }

    if (dados?.status === "erro" && dados?.mensagemWhatsapp) {
      await enviarTextoCanal(from, dados.mensagemWhatsapp, contexto);
      await delay(500);
      await enviarTextoCanal(
        from,
        "Digite *menu* para voltar ao início.",
        contexto,
      );
      estadoUsuario[from] = null;
      return;
    }

    if (
      !dados ||
      !Array.isArray(dados.veiculos) ||
      dados.veiculos.length === 0
    ) {
      await enviarTextoCanal(
        from,
        `❌ ${dados?.mensagem || "Nenhum registro encontrado."}`,
        contexto,
      );
      estadoUsuario[from] = null;
      return;
    }

    const comBoleto = dados.veiculos.filter(existeBoletoDisponivel);

    if (comBoleto.length === 0) {
      await enviarTextoCanal(
        from,
        `⚠️ ${dados?.mensagem || "Cadastro encontrado, mas não há participação mensal em aberto no momento."}`,
        contexto,
      );
      estadoUsuario[from] = null;
      return;
    }

    for (let i = 0; i < comBoleto.length; i++) {
      const v = comBoleto[i];
      await enviarTextoCanal(from, montarResumoVeiculo(v, i), contexto);
      if (existeLinhaDigitavel(v)) {
        await delay(500);
        await enviarTextoCanal(
          from,
          String(v.linhadigitavel).replace(/\s+/g, ""),
          contexto,
        );
      }
      await delay(DELAY_ENVIO_MS);
    }

    await enviarTextoCanal(
      from,
      "Digite *menu* para voltar ao início ou *7* para encerrar.",
      contexto,
    );
    estadoUsuario[from] = null;
  } catch (erro) {
    console.error("Erro no fluxo de pagamento:", erro.message);
    await enviarTextoCanal(
      from,
      "❌ Não consegui consultar sua participação mensal agora. Tente novamente em instantes.",
      contexto,
    );
    estadoUsuario[from] = null;
  }
}

// =============================================================================
// PROCESSAMENTO CENTRAL DE MENSAGENS
// =============================================================================
async function processarMensagem({
  from,
  bodyText,
  origem = "meta",
  conversationId = null,
}) {
  const texto = String(bodyText || "")
    .toLowerCase()
    .trim();
  const http = axiosInterno();
  const contexto = { origem, conversationId };

  // 0. Modo humano — bot silencioso até o cliente pedir menu/bot
  if (modoHumano.has(from)) {
    if (["menu", "bot", "oi", "olá", "ola"].includes(texto)) {
      modoHumano.delete(from);
      estadoUsuario[from] = null;

      const canal = obterUltimoCanal(from);
      const convId = conversationId || canal?.conversationId;
      if (convId) await marcarConversaResolvidaChatwoot(convId);

      let cliente = null;
      try {
        const resposta = await http.post("/clienteTelefone", {
          telefone: from,
        });
        cliente = resposta.data;
      } catch (_) {}

      await enviarMenu(from, cliente, contexto);
    }
    return;
  }

  // 1. Fluxo avaliação
  if (estadoUsuario[from] === "avaliacao") {
    await processarAvaliacao(from, texto, contexto);
    return;
  }

  // 1b. Submenu assistência
  if (estadoUsuario[from] === "assistencia") {
    if (texto === "1") {
      estadoUsuario[from] = null;
      await enviarTextoCanal(
        from,
        `🚨 *Assistência 24h — Roubo ou Furto*\n\n` +
          `Em caso de roubo ou furto do seu veículo, mantenha a calma e siga as orientações:\n\n` +
          `1️⃣ Ligue imediatamente para o *190* e registre a ocorrência.\n` +
          `2️⃣ Em seguida, entre em contato com a nossa Assistência 24 horas:\n\n` +
          `📞 *${TELEFONE_ASSISTENCIA}*\n\nEstamos prontos para te ajudar.`,
        contexto,
      );
    } else if (texto === "2") {
      estadoUsuario[from] = null;
      await enviarTextoCanal(
        from,
        `🛠️ *Assistência 24h — Pane Mecânica, Guincho ou Chaveiro*\n\n` +
          `🔧 Em caso de pane mecânica, solicite atendimento para avaliação no local.\n` +
          `🚗 Se necessário, acionaremos o guincho para remoção do veículo.\n` +
          `🔑 Em situações de chaveiro, enviaremos um profissional para te auxiliar.\n\n` +
          `📞 *${TELEFONE_ASSISTENCIA}*\n\nEstamos à disposição para cuidar de você! 💛`,
        contexto,
      );
    } else if (texto === "3") {
      estadoUsuario[from] = null;
      await enviarTextoCanal(
        from,
        `💥 *Assistência 24h — Colisão, Acidente, Danos a Terceiros ou Incêndio*\n\n` +
          `1️⃣ Verifique se há vítimas e acione o *192* (SAMU) ou *193* (Bombeiros) se necessário.\n` +
          `2️⃣ Em caso de colisão ou danos, ligue para o *190* para registro da ocorrência.\n` +
          `3️⃣ Em seguida, entre em contato com a nossa Assistência 24 horas:\n\n` +
          `📞 *${TELEFONE_ASSISTENCIA}*\n\nEstamos aqui para te orientar e prestar todo o suporte necessário.`,
        contexto,
      );
    } else {
      await enviarTextoCanal(
        from,
        `❌ Opção inválida. Por favor, responda com *1*, *2* ou *3*:\n\n` +
          `1️⃣ 🚨 Roubo ou Furto\n2️⃣ 🛠️ Pane, Guincho ou Chaveiro\n3️⃣ 💥 Colisão, Acidente ou Incêndio`,
        contexto,
      );
    }
    return;
  }

  // 2. Opt-out / opt-in
  if (texto === "0" || texto === "parar") {
    usuariosOptOut.add(from);
    estadoUsuario[from] = null;
    await enviarTextoCanal(
      from,
      `✅ *Notificações preventivas desativadas.*\n\nVocê não receberá mais os lembretes de 5 e 2 dias antes do vencimento.\n\nSe quiser voltar a receber, digite *voltar*.`,
      contexto,
    );
    return;
  }

  if (texto === "voltar") {
    usuariosOptOut.delete(from);
    estadoUsuario[from] = null;
    await enviarTextoCanal(
      from,
      `✅ *Notificações ativadas novamente!*\n\nVocê voltará a receber nossos lembretes preventivos. Obrigado!`,
      contexto,
    );
    return;
  }

  // 3. Menu
  if (["oi", "olá", "ola", "menu", "inicio", "início"].includes(texto)) {
    estadoUsuario[from] = null;
    let cliente = null;
    try {
      const resposta = await http.post("/clienteTelefone", { telefone: from });
      cliente = resposta.data;
    } catch (_) {}
    await enviarMenu(from, cliente, contexto);
    return;
  }

  // 4. Placa enviada direto → pagamento
  if (parecePlaca(bodyText)) {
    estadoUsuario[from] = "pagamento";
  }

  // 5. Opções do menu
  if (texto === "1") {
    await enviarTextoCanal(
      from,
      `📱 *Cotação pelo Aplicativo AVSEG*

Segue o link do aplicativo AVSEG para download:

🤖 Android:
https://play.google.com/store/apps/details?id=com.avsegappcliente

🍎 iOS:
https://apps.apple.com/app/avseg-associado/id6645736685

🔐 Seu usuário e senha são os números do seu CPF.

Após instalar, acesse o app e siga o caminho:

📋 Menu > Cotação

Fico à disposição em caso de dúvidas!`,
      contexto,
    );
    return;
  }

  if (texto === "2") {
    estadoUsuario[from] = "pagamento";
    await enviarTextoCanal(
      from,
      `💳 *Pagamentos — 2ª via da participação mensal*\n\nEnvie um dos dados abaixo:\n\n• 📋 CPF do titular\n• 🏢 CNPJ\n• 🚗 Placa do veículo`,
      contexto,
    );
    return;
  }

  if (texto === "3") {
    estadoUsuario[from] = "assistencia";
    await enviarTextoCanal(
      from,
      `🚨 *Acione Assistência 24h*\n\nPara receber o atendimento adequado, selecione o que aconteceu:\n\n` +
        `1️⃣ 🚨 Roubo ou Furto\n2️⃣ 🛠️ Pane, Guincho ou Chaveiro\n3️⃣ 💥 Colisão, Acidente ou Incêndio`,
      contexto,
    );
    return;
  }

  if (texto === "4") {
    await enviarTextoCanal(
      from,
      `📱 *Vistoria pelo Aplicativo AVSEG*

Segue o link do aplicativo AVSEG para download:

🤖 Android:
https://play.google.com/store/apps/details?id=com.avsegappcliente

🍎 iOS:
https://apps.apple.com/app/avseg-associado/id6645736685

🔐 Seu usuário e senha são os números do seu CPF.

Após instalar, acesse o app e siga o caminho:

🔍 Menu > Vistoria > Iniciar

Fico à disposição em caso de dúvidas!`,
      contexto,
    );
    return;
  }

  // 5 — Falar com atendente (cria conversa no Chatwoot)
  if (texto === "5") {
    modoHumano.add(from);
    estadoUsuario[from] = null;

    await enviarTextoCanal(
      from,
      `👨‍💻 *Atendimento Humano*\n\nVocê será atendido por um de nossos especialistas em instantes. ✅\n\nSe quiser voltar ao menu automático, basta digitar *menu*.`,
      contexto,
    );

    // Cria ou abre conversa no Chatwoot
    if (temChatwootConfigurado()) {
      try {
        let convId = conversationId || obterUltimoCanal(from)?.conversationId;

        if (!convId) {
          // Cria nova conversa no Chatwoot
          convId = await criarConversaChatwoot(from, "Associado");
        } else {
          await abrirConversaHumanaChatwoot(convId);
        }

        if (convId) {
          atualizarUltimoCanal(from, { conversationId: convId });
          // Envia nota interna no Chatwoot informando o contexto
          await enviarTextoChatwoot(
            convId,
            `🤖 Cliente solicitou atendimento humano via WhatsApp.\nNúmero: +${from}`,
            true, // nota privada
          );
        }
      } catch (erro) {
        console.error("❌ Erro ao criar conversa no Chatwoot:", erro.message);
      }
    }

    console.log(`👤 Atendimento humano ativado para ${from}`);
    return;
  }

  if (texto === "6") {
    await iniciarAvaliacao(from, contexto);
    return;
  }

  if (["7", "encerrar", "finalizar", "sair"].includes(texto)) {
    estadoUsuario[from] = null;
    modoHumano.delete(from);

    await enviarTextoCanal(
      from,
      `✅ *Conversa encerrada.*\n\nFoi um prazer te atender! 😊\n\nQuando precisar, é só enviar *oi* ou *menu*. Estaremos aqui!\n\n🦁 *AVSEG Proteção Veicular*`,
      contexto,
    );

    const canal = obterUltimoCanal(from);
    const convId = conversationId || canal?.conversationId;
    if (convId) await marcarConversaResolvidaChatwoot(convId);
    return;
  }

  // Pagamento (estado ativo)
  if (estadoUsuario[from] === "pagamento") {
    await processarPagamento(from, bodyText, contexto);
    return;
  }

  // Fallback
  await enviarTextoCanal(
    from,
    `Não entendi sua mensagem. 😅\n\nDigite *menu* para ver todas as opções disponíveis.`,
    contexto,
  );
}

// =============================================================================
// EVENTOS — META
// =============================================================================
app.on("wa_message", async ({ from, bodyText }) => {
  atualizarUltimoCanal(from, { origem: "meta" });
  await processarMensagem({
    from,
    bodyText,
    origem: "meta",
    conversationId: null,
  });
});

// =============================================================================
// EVENTOS — CHATWOOT
// =============================================================================
app.on("chatwoot_message", async ({ from, bodyText, conversationId, raw }) => {
  atualizarUltimoCanal(from, {
    origem: "chatwoot",
    conversationId,
    inboxId: raw?.conversation?.inbox_id || null,
    contactId: raw?.sender?.id || raw?.contact?.id || null,
  });

  await processarMensagem({
    from,
    bodyText,
    origem: "chatwoot",
    conversationId,
  });
});

// =============================================================================
// CRON — NOTIFICAÇÕES DIÁRIAS (09:00)
// =============================================================================
if (ENABLE_CRON) {
  cron.schedule("0 9 * * *", async () => {
    console.log("⏰ Iniciando rotina de notificações diárias...");
    const http = axiosInterno();

    try {
      const resposta = await http.get("/notificacoes-pendentes");
      const notificacoes = Array.isArray(resposta.data?.notificacoes)
        ? resposta.data.notificacoes
        : [];

      console.log(`📋 Total de notificações: ${notificacoes.length}`);
      console.log("📊 Resumo:", JSON.stringify(resposta.data?.resumo || {}));

      for (const item of notificacoes) {
        const telefone = normalizarTelefoneBR(item?.telefone || "");
        if (!telefone) continue;

        if (
          usuariosOptOut.has(telefone) &&
          (item.tipo === "lembrete_5" || item.tipo === "lembrete_2")
        ) {
          console.log(`⏭️ Opt-out: ${telefone} ignorado (${item.tipo})`);
          continue;
        }

        if (modoHumano.has(telefone)) {
          console.log(`⏭️ Modo humano: ${telefone} ignorado (${item.tipo})`);
          continue;
        }

        const mensagem = montarMensagemNotificacao(item);
        if (!mensagem) continue;

        await enviarTextoCanal(telefone, mensagem, { origem: "meta" });

        if (item.url && item.url !== "ND" && item.tipo !== "aniversario") {
          await delay(500);
          await enviarTextoCanal(
            telefone,
            `🔗 *Acesse sua participação mensal:*\n${item.url}`,
            { origem: "meta" },
          );
        }

        await delay(DELAY_ENVIO_MS);
      }

      console.log("✅ Rotina de notificações concluída.");
    } catch (erro) {
      console.error(
        "❌ Erro na rotina de notificações:",
        erro.response?.data || erro.message,
      );
    }
  });

  console.log("⏰ CRON habilitado — notificações diárias às 09:00.");
} else {
  console.log("🧪 CRON desabilitado (ENABLE_CRON != true).");
}

// =============================================================================
// ROTAS DE DIAGNÓSTICO
// =============================================================================
function protegerRotaInterna(req, res, next) {
  const chave = req.headers["x-api-key"];
  if (!INTERNAL_API_KEY || chave !== INTERNAL_API_KEY) {
    return res.status(401).json({ status: "erro", mensagem: "Não autorizado" });
  }
  next();
}

app.get("/avaliacoes", protegerRotaInterna, (req, res) => {
  const media =
    avaliacoes.length > 0
      ? (
          avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length
        ).toFixed(2)
      : null;
  res.json({ total: avaliacoes.length, media, avaliacoes });
});

app.get("/modo-humano", protegerRotaInterna, (req, res) => {
  res.json({ total: modoHumano.size, numeros: [...modoHumano] });
});

app.get("/canais", protegerRotaInterna, (req, res) => {
  res.json({
    total: Object.keys(ultimoCanalPorNumero).length,
    canais: ultimoCanalPorNumero,
  });
});

console.log(
  `🤖 Bot iniciado. TEST_MODE=${TEST_MODE ? "ON" : "OFF"} | CHATWOOT=${temChatwootConfigurado() ? "ON" : "OFF"}`,
);

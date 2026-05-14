require("dotenv").config();

const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const TEMPLATE_MAP = {
  lembrete_5: "lembrete_5_dias",
  lembrete_2: "lembrete_2_dia",
  cobranca_4: "aviso_pendencia_4_dias",
  cobranca_15: "aviso_pendencia_15_dias",
  aniversario: "aniversario_cliente",
};

const {
  app,
  enviarTexto,
  enviarImagem,
  enviarTemplate,
  normalizarTelefoneBR,
  registrarLogNotificacao,
  registrarLogConversa,
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

const MAX_TEMPLATES_POR_CLIENTE_DIA = Number(
  process.env.MAX_TEMPLATES_POR_CLIENTE_DIA || 1,
);

const MAX_TEMPLATES_POR_HORA = Number(process.env.MAX_TEMPLATES_POR_HORA || 50);

const DELAY_TEMPLATE_MIN_MS = Number(process.env.DELAY_TEMPLATE_MIN_MS || 8000);

const DELAY_TEMPLATE_MAX_MS = Number(
  process.env.DELAY_TEMPLATE_MAX_MS || 20000,
);

const ARQUIVO_ENVIOS = path.join(__dirname, "envios_templates.json");
const ARQUIVO_OPTOUT = path.join(__dirname, "usuarios_optout.json");
const ARQUIVO_LOG_AVALIACOES = path.join(__dirname, "logs_avaliacoes.json");
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
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || "";

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
const usuariosOptOut = carregarOptOut();
const avaliacoes = [];
const ultimoCanalPorNumero = Object.create(null);

// =============================================================================
// UTILITÁRIOS
// =============================================================================
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function estaEmHorarioAtendimento() {
  const agora = new Date();

  // Ajuste Brasil/Bahia UTC-3
  const horaBrasil = (agora.getUTCHours() - 3 + 24) % 24;

  // Dia da semana em UTC ajustado para Brasil
  const dataBrasil = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const diaSemana = dataBrasil.getUTCDay();

  // getUTCDay():
  // 0 = domingo
  // 1 = segunda
  // 2 = terça
  // 3 = quarta
  // 4 = quinta
  // 5 = sexta
  // 6 = sábado

  // Domingo fechado
  if (diaSemana === 0) {
    return false;
  }

  // Sábado: 08:00 às 12:00
  if (diaSemana === 6) {
    return horaBrasil >= 8 && horaBrasil < 12;
  }

  // Segunda a sexta: 08:00 às 18:00
  return horaBrasil >= 8 && horaBrasil < 18;
}
function carregarJson(caminho, padrao) {
  try {
    if (!fs.existsSync(caminho)) return padrao;

    const conteudo = fs.readFileSync(caminho, "utf8");
    if (!conteudo.trim()) return padrao;

    return JSON.parse(conteudo);
  } catch (erro) {
    console.error(
      `❌ Erro ao carregar ${path.basename(caminho)}:`,
      erro.message,
    );
    return padrao;
  }
}

function salvarJson(caminho, dados) {
  try {
    fs.writeFileSync(caminho, JSON.stringify(dados, null, 2));
  } catch (erro) {
    console.error(`❌ Erro ao salvar ${path.basename(caminho)}:`, erro.message);
  }
}
function registrarLogAvaliacao(item) {
  try {
    const logs = carregarJson(ARQUIVO_LOG_AVALIACOES, []);

    logs.unshift({
      ...item,
      data: new Date().toISOString(),
    });

    salvarJson(ARQUIVO_LOG_AVALIACOES, logs.slice(0, 1000));
  } catch (erro) {
    console.error("❌ Erro ao registrar avaliação:", erro.message);
  }
}

function carregarOptOut() {
  const dados = carregarJson(ARQUIVO_OPTOUT, []);
  return new Set(Array.isArray(dados) ? dados : []);
}

function salvarOptOut() {
  salvarJson(ARQUIVO_OPTOUT, [...usuariosOptOut]);
}

function montarParametrosTemplate(item) {
  if (item.tipo === "aniversario") {
    return [item.nome || "Associado"];
  }

  return [
    item.nome || "Associado",
    item.placa || "ND",
    formatarDataBR(item.vencimento),
  ];
}
function delayAleatorioTemplate() {
  const min = DELAY_TEMPLATE_MIN_MS;
  const max = DELAY_TEMPLATE_MAX_MS;

  if (max <= min) return min;

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function carregarEnvios() {
  try {
    if (!fs.existsSync(ARQUIVO_ENVIOS)) {
      return {
        porDia: {},
        porHora: {},
        enviosExatos: {},
      };
    }

    const conteudo = fs.readFileSync(ARQUIVO_ENVIOS, "utf8");
    return JSON.parse(conteudo);
  } catch (erro) {
    console.error("❌ Erro ao carregar envios_templates.json:", erro.message);
    return {
      porDia: {},
      porHora: {},
      enviosExatos: {},
    };
  }
}

function salvarEnvios(dados) {
  try {
    fs.writeFileSync(ARQUIVO_ENVIOS, JSON.stringify(dados, null, 2));
  } catch (erro) {
    console.error("❌ Erro ao salvar envios_templates.json:", erro.message);
  }
}

function chaveDia() {
  return new Date().toISOString().slice(0, 10);
}

function chaveHora() {
  return new Date().toISOString().slice(0, 13);
}

function montarChaveExataEnvio(item, telefone, templateName) {
  const placa = item.placa || "ND";
  const vencimento = formatarDataBR(item.vencimento || "ND");

  return [
    telefone,
    templateName,
    item.tipo || "sem_tipo",
    placa,
    vencimento,
  ].join("|");
}

function podeEnviarTemplateSeguro(item, telefone, templateName) {
  const envios = carregarEnvios();

  const dia = chaveDia();
  const hora = chaveHora();

  const chaveClienteDia = `${dia}|${telefone}`;
  const chaveGlobalHora = hora;
  const chaveExata = montarChaveExataEnvio(item, telefone, templateName);

  const totalClienteDia = envios.porDia[chaveClienteDia] || 0;
  const totalHora = envios.porHora[chaveGlobalHora] || 0;
  const jaEnviadoExato = Boolean(envios.enviosExatos[chaveExata]);

  if (jaEnviadoExato) {
    return {
      permitido: false,
      motivo: `duplicado exato: ${chaveExata}`,
    };
  }

  if (totalClienteDia >= MAX_TEMPLATES_POR_CLIENTE_DIA) {
    return {
      permitido: false,
      motivo: `limite diário do cliente atingido: ${telefone}`,
    };
  }

  if (totalHora >= MAX_TEMPLATES_POR_HORA) {
    return {
      permitido: false,
      motivo: `limite global por hora atingido: ${hora}`,
    };
  }

  return {
    permitido: true,
    envios,
    chaveClienteDia,
    chaveGlobalHora,
    chaveExata,
  };
}

function registrarEnvioTemplate(controle) {
  const envios = controle.envios || carregarEnvios();

  envios.porDia[controle.chaveClienteDia] =
    (envios.porDia[controle.chaveClienteDia] || 0) + 1;

  envios.porHora[controle.chaveGlobalHora] =
    (envios.porHora[controle.chaveGlobalHora] || 0) + 1;

  envios.enviosExatos[controle.chaveExata] = {
    enviadoEm: new Date().toISOString(),
  };

  salvarEnvios(envios);
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
    timeout: 180000,
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
async function criarOuBuscarContatoChatwoot(telefone, nome = "Cliente") {
  if (!temChatwootConfigurado()) return null;

  const nomeFinal =
    nome && nome !== "Associado" && nome !== "Cliente"
      ? nome
      : "Cliente";

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
      const contato = contatos[0];

      console.log(`🔍 Contato encontrado no Chatwoot: ${contato.id}`);

      // Atualiza o nome se veio nome real do WhatsApp
      if (
        nomeFinal &&
        nomeFinal !== "Cliente" &&
        contato.name !== nomeFinal
      ) {
        try {
          await axios.put(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contato.id}`,
            {
              name: nomeFinal,
              phone_number: `+${telefone}`,
            },
            {
              headers: montarHeadersChatwoot(),
              timeout: 10000,
            },
          );

          console.log(`✅ Nome atualizado no Chatwoot: ${nomeFinal}`);
        } catch (erroUpdate) {
          console.error(
            "⚠️ Contato encontrado, mas não consegui atualizar nome:",
            erroUpdate.response?.data || erroUpdate.message,
          );
        }
      }

      return contato.id;
    }
  } catch (_) {}

  // Cria novo contato
  try {
    const criado = await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
      {
        name: nomeFinal,
        phone_number: `+${telefone}`,
      },
      {
        headers: montarHeadersChatwoot(),
        timeout: 10000,
      },
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
    let inboxId = CHATWOOT_INBOX_ID;

    if (!inboxId) {
      const inboxes = await axios.get(
        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes`,
        { headers: montarHeadersChatwoot(), timeout: 10000 },
      );

      const inbox = inboxes.data?.payload?.find((i) =>
        String(i.channel_type || "")
          .toLowerCase()
          .includes("api"),
      );

      if (!inbox) {
        console.error(
          "❌ Inbox API não encontrada no Chatwoot. Configure CHATWOOT_INBOX_ID no .env",
        );
        return null;
      }

      inboxId = inbox.id;
    }

    const conversa = await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
      { inbox_id: Number(inboxId), contact_id: contactId, status: "open" },
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
async function enviarMensagemClienteChatwoot(conversationId, texto) {
  if (!temChatwootConfigurado() || !conversationId || !texto) return;

  try {
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

    const response = await axios.post(
      url,
      {
        content: texto,
        message_type: "incoming",
        private: false,
        source_id: `wa_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      },
      {
        headers: montarHeadersChatwoot(),
        timeout: 15000,
      },
    );

    console.log(
      `✅ Mensagem do cliente enviada ao Chatwoot conv=${conversationId}:`,
      response.data?.id || "ok",
    );

    return response.data;
  } catch (erro) {
    console.error(
      "❌ Erro ao enviar mensagem do cliente para Chatwoot:",
      erro.response?.data || erro.message,
    );
  }
}
async function baixarMidiaMeta(mediaId) {
  if (!mediaId) return null;

  try {
    // 1. Busca URL temporária da mídia
    const metaInfo = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
        timeout: 15000,
      },
    );

    const mediaUrl = metaInfo.data?.url;
    const mimeType = metaInfo.data?.mime_type || "application/octet-stream";

    if (!mediaUrl) return null;

    // 2. Baixa o arquivo
    const arquivo = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      responseType: "arraybuffer",
      timeout: 30000,
    });

    return {
      buffer: Buffer.from(arquivo.data),
      mimeType,
    };
  } catch (erro) {
    console.error(
      "❌ Erro ao baixar mídia da Meta:",
      erro.response?.data || erro.message,
    );
    return null;
  }
}

function obterMidiaDaMensagem(message) {
  if (!message) return null;

  if (message.type === "image") {
    return {
      mediaId: message.image?.id,
      mimeType: message.image?.mime_type || "image/jpeg",
      filename: `imagem_${Date.now()}.jpg`,
      legenda: message.image?.caption || "",
    };
  }

  if (message.type === "document") {
    return {
      mediaId: message.document?.id,
      mimeType: message.document?.mime_type || "application/octet-stream",
      filename: message.document?.filename || `documento_${Date.now()}`,
      legenda: message.document?.caption || "",
    };
  }

  if (message.type === "audio") {
    return {
      mediaId: message.audio?.id,
      mimeType: message.audio?.mime_type || "audio/ogg",
      filename: `audio_${Date.now()}.ogg`,
      legenda: "",
    };
  }

  if (message.type === "video") {
    return {
      mediaId: message.video?.id,
      mimeType: message.video?.mime_type || "video/mp4",
      filename: `video_${Date.now()}.mp4`,
      legenda: message.video?.caption || "",
    };
  }

  return null;
}

async function enviarAnexoClienteChatwoot(conversationId, message) {
  if (!temChatwootConfigurado() || !conversationId || !message) return;

  const midia = obterMidiaDaMensagem(message);

  if (!midia?.mediaId) return;

  const baixado = await baixarMidiaMeta(midia.mediaId);

  if (!baixado?.buffer) return;

  try {
    const FormData = require("form-data");
    const form = new FormData();

    form.append("message_type", "incoming");
    form.append("private", "false");
    form.append("content", midia.legenda || `[${message.type}]`);
    form.append(
      "attachments[]",
      baixado.buffer,
      {
        filename: midia.filename,
        contentType: midia.mimeType || baixado.mimeType,
      },
    );

    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

    const response = await axios.post(url, form, {
      headers: {
        api_access_token: CHATWOOT_API_TOKEN,
        ...form.getHeaders(),
      },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    console.log(
      `✅ Anexo enviado ao Chatwoot conv=${conversationId}:`,
      response.data?.id || "ok",
    );

    return response.data;
  } catch (erro) {
    console.error(
      "❌ Erro ao enviar anexo para Chatwoot:",
      erro.response?.data || erro.message,
    );
  }
}
async function espelharMensagemNoChatwoot({
  from,
  bodyText,
  msgType = "text",
  message = null,
  nomeCliente = "Cliente",
}) {
  if (!temChatwootConfigurado()) return null;

  try {
    let convId = obterUltimoCanal(from)?.conversationId;

    if (!convId) {
      convId = await criarConversaChatwoot(from, nomeCliente || "Cliente");

      if (convId) {
        atualizarUltimoCanal(from, {
          origem: "meta",
          conversationId: convId,
        });
      }
    }

    if (!convId) return null;

    const textoParaChatwoot =
  bodyText && String(bodyText).trim()
    ? bodyText
    : `[${msgType || "mensagem"} recebida]`;

if (msgType === "text") {
  await enviarMensagemClienteChatwoot(convId, textoParaChatwoot);
} else {
  const anexoEnviado = await enviarAnexoClienteChatwoot(convId, message);

  if (!anexoEnviado) {
    await enviarMensagemClienteChatwoot(convId, textoParaChatwoot);
  } else if (bodyText && String(bodyText).trim()) {
    await enviarMensagemClienteChatwoot(convId, bodyText);
  }
}

    return convId;
  } catch (erro) {
    console.error(
      "❌ Erro ao espelhar mensagem no Chatwoot:",
      erro.response?.data || erro.message,
    );
    return null;
  }
}
async function registrarAcaoClienteChatwoot(from, acao, conversationId = null) {
  if (!temChatwootConfigurado()) return;

  try {
    let convId = conversationId || obterUltimoCanal(from)?.conversationId;

    if (!convId) {
      convId = await criarConversaChatwoot(from, "Cliente");

      if (convId) {
        atualizarUltimoCanal(from, {
          origem: "meta",
          conversationId: convId,
        });
      }
    }

    if (!convId) return;

    await enviarTextoChatwoot(
      convId,
      `🧭 *Ação identificada pelo bot*\n\n${acao}\n\n📱 Número: +${from}`,
      true
    );
  } catch (erro) {
    console.error(
      "❌ Erro ao registrar ação do cliente no Chatwoot:",
      erro.response?.data || erro.message
    );
  }
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
  registrarLogAvaliacao({
    telefone: normalizarTelefoneBR(from),
    nota,
    origem: contexto.origem || "meta",
  });

  avaliacoes.push({
    telefone: normalizarTelefoneBR(from),
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

    // Envia o telefone do associado para registrar no dashboard
    payload.telefone = from;

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
  msgType = "text",
  message = null,
  nomeCliente = "Cliente",
}) {
  const texto = String(bodyText || "")
    .toLowerCase()
    .trim();
  const http = axiosInterno();
  const contexto = { origem, conversationId };
  // Espelha TODA mensagem recebida pelo WhatsApp no Chatwoot,
// mesmo sem atendimento humano ativo.
let conversationIdChatwoot = conversationId;

if (origem === "meta" && temChatwootConfigurado()) {
  conversationIdChatwoot = await espelharMensagemNoChatwoot({
  from,
  bodyText,
  msgType,
  message,
  nomeCliente,
});

  if (conversationIdChatwoot) {
    contexto.conversationId = conversationIdChatwoot;
  }
}

  // 0. Modo humano — bot silencioso até o cliente pedir menu
  // 0. Modo humano — bot silencioso, mas encaminha mensagens para o Chatwoot
  if (modoHumano.has(from)) {
  const canal = obterUltimoCanal(from);
  const convId = conversationIdChatwoot || conversationId || canal?.conversationId;

  if (texto.trim().toLowerCase() === "menu") {
    modoHumano.delete(from);
    estadoUsuario[from] = null;

    if (convId) await marcarConversaResolvidaChatwoot(convId);

    let cliente = null;
    try {
      const resposta = await http.post("/clienteTelefone", {
        telefone: from,
      });
      cliente = resposta.data;
    } catch (_) {}

    await enviarMenu(from, cliente, contexto);
    return;
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

  // 2. Opt-out / opt-in (melhorado)
  const textoLimpo = texto.trim().toLowerCase();

  if (textoLimpo === "0" || textoLimpo === "parar") {
    usuariosOptOut.add(normalizarTelefoneBR(from));
    salvarOptOut();
    estadoUsuario[from] = null;

    await enviarTextoCanal(
      from,
      `🚫 *Notificações desativadas com sucesso.*\n\n` +
        `Você não receberá mais:\n` +
        `• Lembretes de vencimento\n` +
        `• Avisos de pendência\n\n` +
        `Se quiser voltar a receber, digite *ativar notificações*.`,
      contexto,
    );
    return;
  }

  if (textoLimpo === "ativar notificações") {
    usuariosOptOut.delete(normalizarTelefoneBR(from));
    salvarOptOut();
    estadoUsuario[from] = null;

    await enviarTextoCanal(
      from,
      `✅ *Notificações reativadas com sucesso!*\n\n` +
        `Você voltará a receber lembretes e avisos normalmente. 📩`,
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
    await registrarAcaoClienteChatwoot(
  from,
  "Opção 1 - Cotação pelo Aplicativo AVSEG",
  contexto.conversationId
);
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
    await registrarAcaoClienteChatwoot(
  from,
  "Opção 2 - Pagamentos / 2ª via da participação mensal",
  contexto.conversationId
);
    estadoUsuario[from] = "pagamento";
    await enviarTextoCanal(
      from,
      `💳 *Pagamentos — 2ª via da participação mensal*\n\nEnvie um dos dados abaixo:\n\n• 📋 CPF do titular\n• 🏢 CNPJ\n• 🚗 Placa do veículo`,
      contexto,
    );
    return;
  }

  if (texto === "3") {
    await registrarAcaoClienteChatwoot(
  from,
  "Opção 3 - Acionar Assistência 24h",
  contexto.conversationId
);
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
  await registrarAcaoClienteChatwoot(
    from,
    "Opção 4 - Vistoria pelo Aplicativo AVSEG",
    contexto.conversationId
  );

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
    await registrarAcaoClienteChatwoot(
  from,
  "Opção 5 - Solicitou atendimento humano",
  contexto.conversationId
);
    if (!estaEmHorarioAtendimento()) {
 await enviarTextoCanal(
  from,
  `⏰ *Atendimento humano indisponível no momento.*

Nosso horário de atendimento é:

🗓️ *Segunda a sexta:* 08:00 às 18:00
🗓️ *Sábado:* 08:00 às 12:00
🚫 *Domingo:* fechado

Digite *menu* para acessar as opções automáticas.`,
  contexto,
);
 return;
}
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
          await enviarMensagemClienteChatwoot(
            convId,
            "Cliente solicitou atendimento humano pelo menu.",
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
    await registrarAcaoClienteChatwoot(
  from,
  "Opção 6 - Avaliação de atendimento",
  contexto.conversationId
);
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
const respostasNaturais = [
  "obrigado",
  "obg",
  "valeu",
  "amei",
  "❤️",
  "😍",
  "🙏",
  "amém",
  "amem",
  "Amém",
  "Amem",
  "parabéns",
  "brigado",
  "show",
  "top",
  "ok",
  "okay",
  "kkk",
  "legal",
  "gratidão",
];

const ehRespostaNatural = respostasNaturais.some((t) =>
  texto.toLowerCase().includes(t)
);

if (ehRespostaNatural) {
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
app.on("wa_message", async ({ from, bodyText, msgType, message, nomeCliente }) => {
  await processarMensagem({
  from,
  bodyText,
  origem: "meta",
  msgType,
  message,
  nomeCliente,
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

  if (!modoHumano.has(from)) {
    console.log(
      `⏭️ Mensagem do Chatwoot ignorada: ${from} não está em atendimento humano.`,
    );
    return;
  }

  if (!bodyText || !String(bodyText).trim()) {
    console.log("⏭️ Mensagem vazia do Chatwoot ignorada.");
    return;
  }

  try {
    await enviarTexto(from, bodyText);

    registrarLogConversa({
      telefone: from,
      nome: "Atendente",
      origem: "atendente",
      tipo: "text",
      mensagem: bodyText,
      conversationId,
    });

    console.log(`✅ Mensagem do atendente enviada para WhatsApp: ${from}`);
  } catch (erro) {
    console.error(
      "❌ Erro ao enviar mensagem do Chatwoot para WhatsApp:",
      erro.response?.data || erro.message,
    );
  }
});

// =============================================================================
// CRON — NOTIFICAÇÕES DIÁRIAS (09:00)
// =============================================================================
function ehDiaDePico() {
  const hoje = new Date();
  // Ajuste UTC-3 Brasil
  const diaBrasil = new Date(hoje.getTime() - 3 * 60 * 60 * 1000).getDate();
  
  // Dias com notificações: 5 dias antes, 2 dias antes, 4 depois, 15 depois
  // dos vencimentos 10, 20 e 30
  const diasAtivos = [5, 8, 10, 14, 15, 18, 20, 24, 25, 28, 30, 3, 4];
  
  return diasAtivos.includes(diaBrasil);
}
if (ENABLE_CRON) {
  cron.schedule("0 11-23,0-1 * * *", async () => {
  if (!ehDiaDePico()) {
  console.log("📅 Dia sem pico — mantendo envio normal com limite por hora.");
}
  
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

        if (!podeEnviar(telefone)) {
          console.log(
            `🧪 TEST_MODE ativo: template bloqueado para ${telefone}`,
          );
          continue;
        }

        if (usuariosOptOut.has(telefone)) {
          console.log(`⏭️ Opt-out: ${telefone} ignorado (${item.tipo})`);
          continue;
        }

        if (modoHumano.has(telefone)) {
          console.log(`⏭️ Modo humano: ${telefone} ignorado (${item.tipo})`);
          continue;
        }

        const templateName = TEMPLATE_MAP[item.tipo];

        if (!templateName) {
          console.log(`⏭️ Tipo sem template configurado: ${item.tipo}`);
          continue;
        }

        const parametros = montarParametrosTemplate(item);

        const controleEnvio = podeEnviarTemplateSeguro(
          item,
          telefone,
          templateName,
        );

        if (!controleEnvio.permitido) {
          console.log(`⏭️ Template bloqueado: ${controleEnvio.motivo}`);
          continue;
        }

        try {
          await enviarTemplate(telefone, templateName, parametros);
          registrarLogNotificacao({
            telefone,
            nome: item.nome || "Associado",
            placa: item.placa || "ND",
            vencimento: item.vencimento || "ND",
            tipo: item.tipo || "ND",
            sistema: item.sistema || "ND",
            status: "enviado",
            template: templateName,
          });
          registrarLogConversa({
  telefone,
  nome: item.nome || "Associado",
  origem: "bot",
  tipo: "template",
  mensagem: templateName,
  status: "enviado",
  sistema: item.sistema || "ND",
});
          registrarEnvioTemplate(controleEnvio);

          const espera = delayAleatorioTemplate();
          console.log(
            `⏳ Aguardando ${Math.round(espera / 1000)}s antes do próximo envio...`,
          );
          await delay(espera);
        } catch (erro) {
          console.error(
            `❌ Erro ao enviar template ${templateName} para ${telefone}:`,
            erro.response?.data || erro.message,
          );
        }
      }

      console.log("✅ Rotina de notificações concluída.");
    } catch (erro) {
      console.error(
        "❌ Erro na rotina de notificações:",
        erro.response?.data || erro.message,
      );
    }
  });

  console.log("⏰ CRON habilitado — notificações de hora em hora das 08:00 às 22:00.");
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

require("dotenv").config();

const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const TEMPLATE_MAP = {
  // lembrete_5: "lembrete_5_dias", // DESATIVADO TEMPORARIAMENTE
  lembrete_2: "lembrete_2_dia",
  cobranca_3: "aviso_pendencia_3_dias",
  cobranca_4: "aviso_pendencia_4_dias",
  cobranca_15: "aviso_pendencia_15_dias",
  aniversario: "aniversario_cliente",
};

const {
  app,
  enviarTexto,
  enviarImagem,
  enviarTemplate,
  enviarListaMenu,
  gerarLinkCurto,
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
const ARQUIVO_CANAIS = path.join(__dirname, "canais_persistentes.json");
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

// Chat AVSEG (substituto do Chatwoot)
const CHAT_AVSEG_ENABLED = process.env.CHAT_AVSEG_ENABLED === "true";
const CHAT_AVSEG_URL = String(process.env.CHAT_AVSEG_URL || "").replace(
  /\/+$/,
  "",
);
// Usa a mesma INTERNAL_API_KEY já validada acima — precisa ser idêntica ao
// INTERNAL_API_KEY do backend/.env do chat-avseg.
const BOT_PUBLIC_URL = String(process.env.BOT_PUBLIC_URL || "").replace(
  /\/+$/,
  "",
);

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
const nomesAssociados = {}; // { "5575981234567": "João" }

// Cache para evitar processar a mesma mensagem duas vezes
const mensagensProcessadas = new Set();
function jaProcessou(messageId) {
  if (!messageId) return false;
  if (mensagensProcessadas.has(messageId)) return true;
  mensagensProcessadas.add(messageId);
  // Limpa o cache quando passar de 1000 entradas
  if (mensagensProcessadas.size > 1000) {
    const primeiro = mensagensProcessadas.values().next().value;
    mensagensProcessadas.delete(primeiro);
  }
  return false;
}

// =============================================================================
// PERSISTÊNCIA DE CANAIS (conversationId por número)
// =============================================================================
const VALIDADE_CANAL_DIAS = 7;

function carregarCanaisPersistentes() {
  try {
    const dados = carregarJson(ARQUIVO_CANAIS, {});
    const agora = Date.now();
    const validos = {};
    for (const [numero, info] of Object.entries(dados)) {
      const diasPassados = (agora - new Date(info.atualizadoEm).getTime()) / (1000 * 60 * 60 * 24);
      if (diasPassados <= VALIDADE_CANAL_DIAS) {
        validos[numero] = info;
        // Restaura em memória
        ultimoCanalPorNumero[numero] = info;
      }
    }
    console.log(`📂 Canais persistentes carregados: ${Object.keys(validos).length}`);
    return validos;
  } catch (erro) {
    console.error("❌ Erro ao carregar canais persistentes:", erro.message);
    return {};
  }
}

function salvarCanalPersistente(numero, dados) {
  try {
    const canais = carregarJson(ARQUIVO_CANAIS, {});
    canais[numero] = { ...dados, atualizadoEm: new Date().toISOString() };
    salvarJson(ARQUIVO_CANAIS, canais);
  } catch (erro) {
    console.error("❌ Erro ao salvar canal persistente:", erro.message);
  }
}

// =============================================================================
// UTILITÁRIOS
// =============================================================================
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estaEmHorarioAtendimento() {
  const agora = new Date();
  const horaBrasil = (agora.getUTCHours() - 3 + 24) % 24;
  const dataBrasil = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const diaSemana = dataBrasil.getUTCDay();

  if (diaSemana === 0) return false;
  if (diaSemana === 6) return horaBrasil >= 8 && horaBrasil < 12;
  return horaBrasil >= 8 && horaBrasil < 18;
}

function carregarJson(caminho, padrao) {
  try {
    if (!fs.existsSync(caminho)) return padrao;
    const conteudo = fs.readFileSync(caminho, "utf8");
    if (!conteudo.trim()) return padrao;
    return JSON.parse(conteudo);
  } catch (erro) {
    console.error(`❌ Erro ao carregar ${path.basename(caminho)}:`, erro.message);
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
    logs.unshift({ ...item, data: new Date().toISOString() });
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

// Templates que suportam botão de URL
const TEMPLATES_COM_BOTAO = ["lembrete_5", "lembrete_2", "cobranca_3"];

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

function montarUrlBotaoTemplate(item) {
  if (!TEMPLATES_COM_BOTAO.includes(item.tipo)) return null;
  const urlReal = item.url && item.url !== "ND" ? item.url : null;
  if (!urlReal) return null;
  return gerarLinkCurto(urlReal);
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
      return { porDia: {}, porHora: {}, enviosExatos: {} };
    }
    const conteudo = fs.readFileSync(ARQUIVO_ENVIOS, "utf8");
    return JSON.parse(conteudo);
  } catch (erro) {
    console.error("❌ Erro ao carregar envios_templates.json:", erro.message);
    return { porDia: {}, porHora: {}, enviosExatos: {} };
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
  return [telefone, templateName, item.tipo || "sem_tipo", placa, vencimento].join("|");
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

  if (jaEnviadoExato) return { permitido: false, motivo: `duplicado exato: ${chaveExata}` };
  if (totalClienteDia >= MAX_TEMPLATES_POR_CLIENTE_DIA) return { permitido: false, motivo: `limite diário do cliente atingido: ${telefone}` };
  if (totalHora >= MAX_TEMPLATES_POR_HORA) return { permitido: false, motivo: `limite global por hora atingido: ${hora}` };

  return { permitido: true, envios, chaveClienteDia, chaveGlobalHora, chaveExata };
}

function registrarEnvioTemplate(controle) {
  const envios = controle.envios || carregarEnvios();
  envios.porDia[controle.chaveClienteDia] = (envios.porDia[controle.chaveClienteDia] || 0) + 1;
  envios.porHora[controle.chaveGlobalHora] = (envios.porHora[controle.chaveGlobalHora] || 0) + 1;
  envios.enviosExatos[controle.chaveExata] = { enviadoEm: new Date().toISOString() };
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
  if (valor === null || valor === undefined || valor === "" || valor === "ND") return "ND";
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

  if (dados.conversationId === null) {
    ultimoCanalPorNumero[numero] = { origem: "meta", conversationId: null };
    return;
  }

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

  const nomeFinal = nome && nome !== "Associado" ? nome : "Associado";

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

      if (nomeFinal && nomeFinal !== "Associado" && contato.name !== nomeFinal) {
        try {
          await axios.put(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contato.id}`,
            { name: nomeFinal, phone_number: `+${telefone}` },
            { headers: montarHeadersChatwoot(), timeout: 10000 },
          );
          console.log(`✅ Nome atualizado no Chatwoot: ${nomeFinal}`);
        } catch (erroUpdate) {
          console.error("⚠️ Não consegui atualizar nome:", erroUpdate.response?.data || erroUpdate.message);
        }
      }

      return contato.id;
    }
  } catch (_) {}

  try {
    const criado = await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
      { name: nomeFinal, phone_number: `+${telefone}` },
      { headers: montarHeadersChatwoot(), timeout: 10000 },
    );
    console.log(`✅ Contato criado no Chatwoot: ${criado.data?.id}`);
    return criado.data?.id;
  } catch (erro) {
    console.error("❌ Erro ao criar contato:", erro.response?.data || erro.message);
    return null;
  }
}

async function criarConversaChatwoot(telefone, nome = "Associado") {
  if (!temChatwootConfigurado()) return null;

  try {
    const contactId = await criarOuBuscarContatoChatwoot(telefone, nome);
    if (!contactId) return null;

    let inboxId = CHATWOOT_INBOX_ID;

    if (!inboxId) {
      const inboxes = await axios.get(
        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes`,
        { headers: montarHeadersChatwoot(), timeout: 10000 },
      );

      const inbox = inboxes.data?.payload?.find((i) =>
        String(i.channel_type || "").toLowerCase().includes("api"),
      );

      if (!inbox) {
        console.error("❌ Inbox API não encontrada no Chatwoot.");
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
    console.error("❌ Erro ao criar conversa:", erro.response?.data || erro.message);
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

  console.log(`✅ TEXTO ENVIADO CHATWOOT conv=${conversationId}:`, response.data?.id || "ok");
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
      { headers: montarHeadersChatwoot(), timeout: 15000 },
    );

    console.log(`✅ Mensagem do cliente enviada ao Chatwoot conv=${conversationId}:`, response.data?.id || "ok");
    return response.data;
  } catch (erro) {
    const status = erro?.response?.status || 0;
    if (status === 404) {
      // Relança o 404 para que espelharMensagemNoChatwoot possa tratar
      throw erro;
    }
    console.error("❌ Erro ao enviar mensagem do associado para Chatwoot:", erro.response?.data || erro.message);
  }
}

async function baixarMidiaMeta(mediaId) {
  if (!mediaId) return null;

  try {
    const metaInfo = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, timeout: 15000 },
    );

    const mediaUrl = metaInfo.data?.url;
    const mimeType = metaInfo.data?.mime_type || "application/octet-stream";

    if (!mediaUrl) return null;

    const arquivo = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 30000,
    });

    return { buffer: Buffer.from(arquivo.data), mimeType };
  } catch (erro) {
    console.error("❌ Erro ao baixar mídia da Meta:", erro.response?.data || erro.message);
    return null;
  }
}

function obterMidiaDaMensagem(message) {
  if (!message) return null;

  if (message.type === "image") return { mediaId: message.image?.id, mimeType: message.image?.mime_type || "image/jpeg", filename: `imagem_${Date.now()}.jpg`, legenda: message.image?.caption || "" };
  if (message.type === "document") return { mediaId: message.document?.id, mimeType: message.document?.mime_type || "application/octet-stream", filename: message.document?.filename || `documento_${Date.now()}`, legenda: message.document?.caption || "" };
  if (message.type === "audio") return { mediaId: message.audio?.id, mimeType: message.audio?.mime_type || "audio/ogg", filename: `audio_${Date.now()}.ogg`, legenda: "" };
  if (message.type === "video") return { mediaId: message.video?.id, mimeType: message.video?.mime_type || "video/mp4", filename: `video_${Date.now()}.mp4`, legenda: message.video?.caption || "" };

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
    form.append("attachments[]", baixado.buffer, {
      filename: midia.filename,
      contentType: midia.mimeType || baixado.mimeType,
    });

    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

    const response = await axios.post(url, form, {
      headers: { api_access_token: CHATWOOT_API_TOKEN, ...form.getHeaders() },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    console.log(`✅ Anexo enviado ao Chatwoot conv=${conversationId}:`, response.data?.id || "ok");
    return response.data;
  } catch (erro) {
    console.error("❌ Erro ao enviar anexo para Chatwoot:", erro.response?.data || erro.message);
  }
}

async function espelharMensagemNoChatwoot({ from, bodyText, msgType = "text", message = null, nomeCliente = "Cliente" }) {
  if (!temChatwootConfigurado()) return null;

  async function enviarParaConversa(convId) {
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
  }

  let convId = obterUltimoCanal(from)?.conversationId;

  // Tenta enviar para conversa existente
  if (convId) {
    try {
      await enviarParaConversa(convId);
      return convId;
    } catch (erro) {
      const status = erro?.response?.status || 0;
      console.log(`⚠️ Erro ao espelhar (status ${status}) para conversa ${convId}: ${erro.message}`);
      if (status === 404) {
        // Conversa deletada — limpa cache e cria nova abaixo
        console.log(`🗑️ Conversa ${convId} deletada. Limpando cache e criando nova...`);
        atualizarUltimoCanal(from, { conversationId: null });
        convId = null;
      } else {
        console.error("❌ Erro ao espelhar no Chatwoot:", erro.response?.data || erro.message);
        return null;
      }
    }
  }

  // Cria nova conversa (primeira vez ou após 404)
  try {
    const novoConvId = await criarConversaChatwoot(from, nomeCliente || "Associado");
    if (!novoConvId) return null;
    atualizarUltimoCanal(from, { origem: "meta", conversationId: novoConvId });
    await enviarParaConversa(novoConvId);
    console.log(`✅ Nova conversa criada no Chatwoot: ${novoConvId}`);
    return novoConvId;
  } catch (erro) {
    console.error("❌ Erro ao criar nova conversa no Chatwoot:", erro.response?.data || erro.message);
    return null;
  }
}

function temChatAvsegConfigurado() {
  return Boolean(CHAT_AVSEG_ENABLED && CHAT_AVSEG_URL && INTERNAL_API_KEY);
}

const TIPO_CHAT_AVSEG_POR_MSGTYPE = {
  text: "texto",
  interactive: "texto",
  image: "imagem",
  audio: "audio",
  video: "video",
  document: "arquivo",
};

async function enviarMensagemParaChatAvseg({ from, bodyText, msgType = "text", nomeCliente = "Cliente", midiaDashboard = null }) {
  if (!temChatAvsegConfigurado()) return null;

  const payload = {
    telefone: from,
    mensagem: bodyText || midiaDashboard?.legenda || "",
    nomeCliente: nomeCliente || "Cliente",
    tipo: TIPO_CHAT_AVSEG_POR_MSGTYPE[msgType] || "texto",
  };

  if (midiaDashboard?.mediaUrl) {
    if (BOT_PUBLIC_URL) {
      payload.arquivoUrl = `${BOT_PUBLIC_URL}${midiaDashboard.mediaUrl}`;
    } else {
      console.warn("⚠️ BOT_PUBLIC_URL não configurado — anexo não será encaminhado ao chat-avseg");
    }
    payload.mimeType = midiaDashboard.mimeType;
    payload.nomeArquivo = midiaDashboard.filename;
  }

  try {
    const resposta = await axios.post(
      `${CHAT_AVSEG_URL}/api/webhook/whatsapp`,
      payload,
      {
        headers: {
          "x-api-key": INTERNAL_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );
    console.log(`✅ Mensagem encaminhada ao chat-avseg: ${from} (conversaId=${resposta.data?.conversaId || "?"})`);
    return resposta.data?.conversaId || null;
  } catch (erro) {
    console.error("❌ Erro ao encaminhar mensagem para chat-avseg:", erro.response?.data || erro.message);
    return null;
  }
}

async function registrarAcaoClienteChatwoot(from, acao, conversationId = null) {
  if (!temChatwootConfigurado()) return;

  try {
    let convId = conversationId || obterUltimoCanal(from)?.conversationId;

    if (!convId) {
      convId = await criarConversaChatwoot(from, "Associado");
      if (convId) atualizarUltimoCanal(from, { origem: "meta", conversationId: convId });
    }

    if (!convId) return;

    await enviarTextoChatwoot(
      convId,
      `🧭 *Ação identificada pelo bot*\n\n${acao}\n\n📱 Número: +${from}`,
      true,
    );
  } catch (erro) {
    console.error("❌ Erro ao registrar ação do cliente no Chatwoot:", erro.response?.data || erro.message);
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
    console.error(`❌ Erro ao abrir conversa humana:`, erro.response?.data || erro.message);
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
    console.error(`❌ Erro ao resolver conversa:`, erro.response?.data || erro.message);
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
      const conversationId = contexto.conversationId || obterUltimoCanal(numero)?.conversationId;
      if (!conversationId) {
        await enviarTexto(numero, texto);
        return;
      }
      await enviarTextoChatwoot(conversationId, texto);
      return;
    }

    // Envia pelo WhatsApp normalmente
    await enviarTexto(numero, texto);
    console.log(`✅ Texto enviado para ${numero}`);

    // Registra no log
    registrarLogConversa({
      telefone: numero,
      nome: "Bot",
      origem: "bot",
      tipo: "text",
      mensagem: texto,
    });

    // Espelha no Chatwoot como nota privada (não gera evento outgoing, evita duplicata)
    if (temChatwootConfigurado()) {
      const conversationId = contexto.conversationId || obterUltimoCanal(numero)?.conversationId;
      if (conversationId) {
        try {
          await enviarTextoChatwoot(conversationId, `🤖 Bot: ${texto}`, true);
        } catch (erroChatwoot) {
          const status = erroChatwoot?.response?.status || 0;
          const msgErr = erroChatwoot?.response?.data?.error || erroChatwoot.message || "";
          if (status === 404 || msgErr.includes("not found") || msgErr.includes("could not be found")) {
            // Conversa deletada — limpa o cache para criar nova na próxima mensagem
            console.log(`⚠️ Conversa ${conversationId} deletada no Chatwoot. Limpando cache...`);
            atualizarUltimoCanal(numero, { conversationId: null });
          } else {
            console.warn(`⚠️ Não foi possível espelhar no Chatwoot:`, erroChatwoot.message);
          }
        }
      } else {
        console.log(`⚠️ Sem conversationId para espelhar no Chatwoot: ${numero}`);
      }
    }
  } catch (erro) {
    console.error(`❌ Erro ao enviar texto para ${numero}:`, erro.response?.data || erro.message);
  }
}

async function enviarImagemCanal(from, imageUrl, caption = "", contexto = {}) {
  const numero = normalizarTelefoneBR(from);
  if (!numero) return;
  if (!podeEnviar(numero)) return;

  try {
    await enviarImagem(numero, imageUrl, caption);
    console.log(`✅ Imagem enviada para ${numero}`);

    // Registra no log
    registrarLogConversa({
      telefone: numero,
      nome: "Bot",
      origem: "bot",
      tipo: "image",
      mensagem: caption ? caption.slice(0, 100) + (caption.length > 100 ? "..." : "") : "[imagem]",
    });

    // Espelha no Chatwoot como nota privada
    if (temChatwootConfigurado() && caption) {
      const conversationId = contexto.conversationId || obterUltimoCanal(numero)?.conversationId;
      if (conversationId) {
        try {
          await enviarTextoChatwoot(conversationId, `🤖 Bot: ${caption.slice(0, 200)}${caption.length > 200 ? "..." : ""}`, true);
        } catch (erroChatwoot) {
          const status = erroChatwoot?.response?.status || 0;
          if (status === 404) {
            atualizarUltimoCanal(numero, { conversationId: null });
          } else {
            console.warn(`⚠️ Não foi possível espelhar imagem no Chatwoot:`, erroChatwoot.message);
          }
        }
      }
    }
  } catch (erro) {
    console.error("Erro enviando imagem:", erro.response?.data || erro.message);
    if (caption) await enviarTextoCanal(numero, caption, contexto);
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
  let bodyText = `Olá`;

  if (cliente && !cliente.erro && Array.isArray(cliente.veiculos) && cliente.veiculos.length) {
    bodyText = `Olá, *${cliente.nome || "Associado"}*! 👋\n\nSeus veículos:\n`;
    cliente.veiculos.forEach((v) => {
      bodyText += `🚗 ${v.placa || "ND"} — Vence: ${v.vencimento || "ND"}\n`;
    });
    bodyText += `\nComo posso te ajudar hoje?`;
  } else {
    bodyText = `Olá! Seja bem-vindo(a) à AVSEG Proteção Veicular! 👋\n\nComo posso te ajudar hoje?`;
  }

  const sections = [
    {
      title: "Opções",
      rows: [
        { id: "1", title: "Cotação", description: "Solicitar cotação pelo app AVSEG" },
        { id: "2", title: "Pagamentos", description: "2ª via da participação mensal" },
        { id: "3", title: "Assistência 24h", description: "Acionar assistência emergencial" },
        { id: "4", title: "Vistoria do veículo", description: "Realizar vistoria pelo app" },
        { id: "5", title: "Falar com atendente", description: "Atendimento humano especializado" },
        { id: "6", title: "Avaliar atendimento", description: "Deixe sua avaliação" },
        { id: "7", title: "Encerrar conversa", description: "Finalizar o atendimento" },
      ],
    },
  ];

  const resultado = await enviarListaMenu(
    numero,
    "🦁 AVSEG Proteção Veicular",
    bodyText,
    "_(Para parar notificações, responda 0)_",
    sections,
  );

  // Espelha menu no Chatwoot como nota privada
  if (resultado && temChatwootConfigurado()) {
    const convId = contexto.conversationId || obterUltimoCanal(numero)?.conversationId;
    if (convId) {
      try {
        await enviarTextoChatwoot(convId, `🤖 Bot: Menu principal enviado ao associado`, true);
      } catch (_) {}
    }
  }

  // Fallback para texto se lista falhar
  if (!resultado) {
    let saudacao = `🦁 *AVSEG Proteção Veicular*\n\n${bodyText}\n\n`;
    saudacao += montarOpcoesMenu();
    saudacao += `\n\n──────────────────\n`;
    saudacao += `📸 *Instagram:* ${INSTAGRAM}\n`;
    saudacao += `📍 *Localização:* ${LOCALIZACAO}\n`;
    saudacao += `\n_(Para parar notificações automáticas, responda *0*)_`;
    await enviarImagemCanal(numero, IMAGEM_BOAS_VINDAS, saudacao, contexto);
  }
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
    await enviarTextoCanal(from, `❌ Nota inválida. Por favor, responda com um número de *1 a 5*.`, contexto);
    return;
  }

  const estrelas = "⭐".repeat(nota);
  registrarLogAvaliacao({ telefone: normalizarTelefoneBR(from), nota, origem: contexto.origem || "meta" });

  avaliacoes.push({ telefone: normalizarTelefoneBR(from), nota, data: new Date().toISOString(), origem: contexto.origem || "meta" });
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
// IDENTIFICAÇÃO DO ASSOCIADO PELO NOME
// =============================================================================
function normalizarNomeAssociado(nomeCompleto) {
  const primeiro = String(nomeCompleto || "").trim().split(/\s+/)[0] || "";
  if (!primeiro || primeiro.toUpperCase() === "ND") return null;
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

function salvarNomeAssociado(from, dados) {
  const nome = dados?.veiculos?.[0]?.nome || dados?.nome;
  const primeiroNome = normalizarNomeAssociado(nome);
  if (primeiroNome) {
    nomesAssociados[from] = primeiroNome;
    console.log(`👤 Nome salvo para ${from}: ${primeiroNome}`);
  }
}

function saudacaoComNome(from) {
  const nome = nomesAssociados[from];
  return nome ? `${nome}, ` : "";
}

// =============================================================================
// FLUXO DE PAGAMENTO
// =============================================================================
async function processarPagamento(from, bodyText, contexto = {}) {
  const http = axiosInterno();
  let payload = { tipo: 2, cpf: "", cnpj: "", placa: "" };

  // Tenta extrair o primeiro dado válido do texto
  // (resolve casos onde cliente manda placa + CPF juntos)
  const palavras = String(bodyText || "").trim().split(/\s+/);
  let dadoEncontrado = false;

  for (const palavra of palavras) {
    if (parecePlaca(palavra)) {
      payload.tipo = 1;
      payload.placa = normalizarPlaca(palavra);
      dadoEncontrado = true;
      break;
    }
    const nums = limparNumeros(palavra);
    if (nums.length === 11) {
      payload.tipo = 2;
      payload.cpf = nums;
      dadoEncontrado = true;
      break;
    }
    if (nums.length === 14) {
      payload.tipo = 3;
      payload.cnpj = nums;
      dadoEncontrado = true;
      break;
    }
  }

  // Tenta também no texto completo sem espaços (ex: CPF colado junto)
  if (!dadoEncontrado) {
    const somenteNumeros = limparNumeros(bodyText);
    if (somenteNumeros.length === 11) {
      payload.tipo = 2;
      payload.cpf = somenteNumeros;
      dadoEncontrado = true;
    } else if (somenteNumeros.length === 14) {
      payload.tipo = 3;
      payload.cnpj = somenteNumeros;
      dadoEncontrado = true;
    }
  }

  if (!dadoEncontrado) {
    await enviarTextoCanal(from, "❌ Não reconheci os dados. Envie a *placa*, *CPF* (11 dígitos) ou *CNPJ* (14 dígitos) separadamente.", contexto);
    return;
  }

  try {
    let dados;
    payload.telefone = from;

    try {
      const resposta = await http.post("/boleto", payload);
      dados = resposta.data;
    } catch (erroApi) {
      dados = erroApi.response?.data;
      if (!dados) {
        await enviarTextoCanal(from, "❌ Não consegui consultar sua participação mensal agora. Tente novamente em instantes.", contexto);
        estadoUsuario[from] = null;
        return;
      }
    }

    if (dados?.status === "sucesso" && dados?.mensagemWhatsapp) {
      salvarNomeAssociado(from, dados);
      await enviarTextoCanal(from, saudacaoComNome(from) + dados.mensagemWhatsapp, contexto);

      const veiculosComLinha = Array.isArray(dados.veiculos) ? dados.veiculos.filter(existeLinhaDigitavel) : [];
      for (const v of veiculosComLinha) {
        await delay(500);
        await enviarTextoCanal(from, String(v.linhadigitavel).replace(/\s+/g, ""), contexto);
      }

      await delay(500);
      await enviarTextoCanal(from, "Digite *menu* para voltar ao início ou *7* para encerrar.", contexto);
      estadoUsuario[from] = null;
      return;
    }

    if (dados?.status === "erro" && dados?.mensagemWhatsapp) {
      await enviarTextoCanal(from, dados.mensagemWhatsapp, contexto);
      await delay(500);
      await enviarTextoCanal(from, "Digite *menu* para voltar ao início.", contexto);
      estadoUsuario[from] = null;
      return;
    }

    if (!dados || !Array.isArray(dados.veiculos) || dados.veiculos.length === 0) {
      await enviarTextoCanal(from, `❌ ${dados?.mensagem || "Nenhum registro encontrado."}`, contexto);
      estadoUsuario[from] = null;
      return;
    }

    salvarNomeAssociado(from, dados);

    const comBoleto = dados.veiculos.filter(existeBoletoDisponivel);

    // Se retornar muitos veículos (CPF/CNPJ com muitos veículos), pede a placa
    if (comBoleto.length > 5) {
      await enviarTextoCanal(
        from,
        `🚗 Encontramos *${comBoleto.length} veículos* associados a esse cadastro.

` +
        `Para localizar a participação mensal correta, por favor informe a *placa do veículo* específico que deseja consultar.`,
        contexto,
      );
      estadoUsuario[from] = "pagamento";
      return;
    }

    if (comBoleto.length === 0) {
      // Verifica se pode ser caso de atraso > 3 dias (precisa de vistoria)
      const temVeiculoComVencimento = Array.isArray(dados.veiculos) && dados.veiculos.some(
        (v) => v.vencimento && v.vencimento !== "ND"
      );

      if (temVeiculoComVencimento) {
        // Cadastro encontrado mas sem boleto disponível — provável atraso > 3 dias
        await enviarTextoCanal(
          from,
          `⚠️ *Pagamento não localizado ou participação mensal indisponível.*

` +
          `Se o seu vencimento passou há mais de *3 dias*, o sistema exige uma *nova vistoria* do veículo antes de gerar uma nova participação mensal.

` +
          `📱 Para realizar a vistoria, acesse o aplicativo AVSEG:
` +
          `🔍 Menu > Vistoria > Iniciar

` +
          `Se precisar de ajuda, digite *5* para falar com um atendente.`,
          contexto,
        );
      } else {
        await enviarTextoCanal(
          from,
          `⚠️ ${dados?.mensagem || "Cadastro encontrado, mas não há participação mensal em aberto no momento."}

Se precisar de ajuda, digite *5* para falar com um atendente.`,
          contexto,
        );
      }
      estadoUsuario[from] = null;
      return;
    }

    for (let i = 0; i < comBoleto.length; i++) {
      const v = comBoleto[i];
      const prefixo = i === 0 ? saudacaoComNome(from) : "";
      await enviarTextoCanal(from, prefixo + montarResumoVeiculo(v, i), contexto);
      if (existeLinhaDigitavel(v)) {
        await delay(500);
        await enviarTextoCanal(from, String(v.linhadigitavel).replace(/\s+/g, ""), contexto);
      }
      await delay(DELAY_ENVIO_MS);
    }

    await enviarTextoCanal(from, "Digite *menu* para voltar ao início ou *7* para encerrar.", contexto);
    estadoUsuario[from] = null;
  } catch (erro) {
    console.error("Erro no fluxo de pagamento:", erro.message);
    await enviarTextoCanal(from, "❌ Não consegui consultar sua participação mensal agora. Tente novamente em instantes.", contexto);
    estadoUsuario[from] = null;
  }
}

// =============================================================================
// IMAGEM — CLASSIFICAÇÃO COM IA VISION
// =============================================================================
async function classificarImagemComIA(base64, mimeType) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          {
            type: "text",
            text: `Classifique esta imagem enviada por um associado de uma empresa de proteção veicular brasileira.

Categorias:
- COMPROVANTE_PAGAMENTO: comprovante de pagamento, recibo, PIX, transferência, boleto pago, extrato bancário
- VISTORIA_VEICULO: foto de carro, moto ou caminhão (veículo em si, não documento)
- DOCUMENTO_BOLETO: boleto bancário, fatura, nota fiscal, documento financeiro
- IMAGEM_GENERICA: bom dia, meme, foto pessoal, paisagem, qualquer outra coisa

Responda APENAS com uma dessas categorias, sem mais nada.`,
          },
        ],
      }],
    }),
  });

  const data = await response.json();
  const categoria = data?.content?.[0]?.text?.trim().toUpperCase();
  const validas = ["COMPROVANTE_PAGAMENTO", "VISTORIA_VEICULO", "DOCUMENTO_BOLETO", "IMAGEM_GENERICA"];
  return validas.includes(categoria) ? categoria : "ERRO_ANALISE";
}

async function processarImagemComIA(from, message, nomeCliente, contexto = {}) {
  const nomeClienteValido =
    nomeCliente && nomeCliente !== "Associado" && nomeCliente !== "Cliente" ? nomeCliente : "";
  const nomeUsar = nomesAssociados[from] || normalizarNomeAssociado(nomeClienteValido) || "";
  const saudacao = nomeUsar ? `${nomeUsar}, ` : "";

  try {
    const mediaId = message?.image?.id;
    if (!mediaId) throw new Error("Sem media_id");

    const baixado = await baixarMidiaMeta(mediaId);
    if (!baixado?.buffer) throw new Error("Falha ao baixar imagem");

    const base64 = baixado.buffer.toString("base64");
    const mimeType = baixado.mimeType || "image/jpeg";
    const categoria = await classificarImagemComIA(base64, mimeType);

    console.log(`🖼️ Imagem classificada [${from}]: ${categoria}`);

    if (categoria === "COMPROVANTE_PAGAMENTO") {
      await enviarTextoCanal(
        from,
        `${saudacao}obrigado por nos avisar! 🤝 Os pagamentos podem levar até 2 dias úteis para serem identificados no sistema. Assim que processado, tudo fica em dia automaticamente.\n\n*AVSEG Proteção Veicular*`,
        contexto,
      );
      return;
    }

    if (categoria === "VISTORIA_VEICULO") {
      await enviarTextoCanal(
        from,
        `Obrigado pelo envio! 🤝 Vou conectar você com um atendente para verificar e dar continuidade ao processo de vistoria.\n\n*AVSEG Proteção Veicular*`,
        contexto,
      );
      modoHumano.add(from);
      estadoUsuario[from] = null;
      if (temChatwootConfigurado()) {
        let convId = contexto.conversationId || obterUltimoCanal(from)?.conversationId;
        if (!convId) convId = await criarConversaChatwoot(from, nomeCliente || "Associado");
        if (convId) {
          atualizarUltimoCanal(from, { conversationId: convId });
          await abrirConversaHumanaChatwoot(convId);
          await enviarTextoChatwoot(convId, `🖼️ *IA: VISTORIA_ENVIANDO*\n\nAssociado enviou foto de veículo para vistoria.\n📱 +${from}`, true);
        }
      }
      return;
    }

    if (categoria === "DOCUMENTO_BOLETO") {
      await enviarTextoCanal(
        from,
        `Recebi seu documento! 📄 Para consultar ou gerar a 2ª via da participação mensal:\n\n• Digite *menu* e escolha a opção *2*\n• Ou envie sua *placa* ou *CPF* diretamente\n\n*AVSEG Proteção Veicular*`,
        contexto,
      );
      return;
    }

    if (categoria === "IMAGEM_GENERICA") {
      await enviarTextoCanal(
        from,
        `Que imagem bacana! 😊 Posso te ajudar com algo? Digite *menu* para ver as opções disponíveis.\n\n*AVSEG Proteção Veicular*`,
        contexto,
      );
      return;
    }

    throw new Error("Categoria inválida");
  } catch (erro) {
    console.error(`❌ Erro ao analisar imagem [${from}]:`, erro.message);
    const dentroDoHorario = estaEmHorarioAtendimento();
    await enviarTextoCanal(
      from,
      dentroDoHorario
        ? `Obrigado pelo envio! 🤝 Um atendente irá verificar em breve.\n\n*AVSEG Proteção Veicular*`
        : `Obrigado pelo envio! 🤝 Nosso horário de atendimento é:\n\n🗓️ *Segunda a sexta:* 08h às 18h\n🗓️ *Sábado:* 08h às 12h\n\nAssim que retornarmos, seu envio será verificado. ✅\n\n*AVSEG Proteção Veicular*`,
      contexto,
    );

    // Escala para humano no fallback
    modoHumano.add(from);
    estadoUsuario[from] = null;
    if (temChatwootConfigurado()) {
      let convId = contexto.conversationId || obterUltimoCanal(from)?.conversationId;
      if (!convId) convId = await criarConversaChatwoot(from, nomeCliente || "Associado");
      if (convId) {
        atualizarUltimoCanal(from, { conversationId: convId });
        await enviarTextoChatwoot(convId, `📎 Associado enviou imagem (não classificada). Aguardando verificação.\n📱 +${from}`, true);
      }
    }
  }
}

// =============================================================================
// PROCESSAMENTO CENTRAL DE MENSAGENS
// =============================================================================
async function processarMensagem({ from, bodyText, origem = "meta", conversationId = null, msgType = "text", message = null, nomeCliente = "Cliente", midiaDashboard = null }) {

  const texto = String(bodyText || "").toLowerCase().trim();
  const http = axiosInterno();
  const contexto = { origem, conversationId };

  // Espelha mensagem no Chatwoot
  let conversationIdChatwoot = conversationId;

  if (origem === "meta" && temChatwootConfigurado()) {
    conversationIdChatwoot = await espelharMensagemNoChatwoot({ from, bodyText, msgType, message, nomeCliente });
    if (conversationIdChatwoot) {
      contexto.conversationId = conversationIdChatwoot;
    } else {
      // Se não retornou convId (ex: após 404), busca o novo que pode ter sido criado
      const canalAtual = obterUltimoCanal(from);
      if (canalAtual?.conversationId) {
        conversationIdChatwoot = canalAtual.conversationId;
        contexto.conversationId = canalAtual.conversationId;
      } else {
        contexto.conversationId = null;
      }
    }
  }

  // Espelha mensagem no chat-avseg (substituto do Chatwoot)
  if (origem === "meta" && temChatAvsegConfigurado()) {
    await enviarMensagemParaChatAvseg({ from, bodyText, msgType, nomeCliente, midiaDashboard });
  }

  // 0. Modo humano
  if (modoHumano.has(from)) {
    const canal = obterUltimoCanal(from);
    const convId = conversationIdChatwoot || conversationId || canal?.conversationId;

    if (texto.trim().toLowerCase() === "menu") {
      modoHumano.delete(from);
      estadoUsuario[from] = null;
      if (convId) await marcarConversaResolvidaChatwoot(convId);

      let cliente = null;
      try {
        const resposta = await http.post("/clienteTelefone", { telefone: from });
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
      await enviarTextoCanal(from, `🚨 *Assistência 24h — Roubo ou Furto*\n\nEm caso de roubo ou furto do seu veículo, mantenha a calma e siga as orientações:\n\n1️⃣ Ligue imediatamente para o *190* e registre a ocorrência.\n2️⃣ Em seguida, entre em contato com a nossa Assistência 24 horas:\n\n📞 *${TELEFONE_ASSISTENCIA}*\n\nEstamos prontos para te ajudar.`, contexto);
    } else if (texto === "2") {
      estadoUsuario[from] = null;
      await enviarTextoCanal(from, `🛠️ *Assistência 24h — Pane Mecânica, Guincho ou Chaveiro*\n\n🔧 Em caso de pane mecânica, solicite atendimento para avaliação no local.\n🚗 Se necessário, acionaremos o guincho para remoção do veículo.\n🔑 Em situações de chaveiro, enviaremos um profissional para te auxiliar.\n\n📞 *${TELEFONE_ASSISTENCIA}*\n\nEstamos à disposição para cuidar de você! 💛`, contexto);
    } else if (texto === "3") {
      estadoUsuario[from] = null;
      await enviarTextoCanal(from, `💥 *Assistência 24h — Colisão, Acidente, Danos a Terceiros ou Incêndio*\n\n1️⃣ Verifique se há vítimas e acione o *192* (SAMU) ou *193* (Bombeiros) se necessário.\n2️⃣ Em caso de colisão ou danos, ligue para o *190* para registro da ocorrência.\n3️⃣ Em seguida, entre em contato com a nossa Assistência 24 horas:\n\n📞 *${TELEFONE_ASSISTENCIA}*\n\nEstamos aqui para te orientar e prestar todo o suporte necessário.`, contexto);
    } else {
      await enviarTextoCanal(from, `❌ Opção inválida. Por favor, responda com *1*, *2* ou *3*:\n\n1️⃣ 🚨 Roubo ou Furto\n2️⃣ 🛠️ Pane, Guincho ou Chaveiro\n3️⃣ 💥 Colisão, Acidente ou Incêndio`, contexto);
    }
    return;
  }

  // 2. Opt-out / opt-in
  const textoLimpo = texto.trim().toLowerCase();

  if (textoLimpo === "0" || textoLimpo === "parar") {
    usuariosOptOut.add(normalizarTelefoneBR(from));
    salvarOptOut();
    estadoUsuario[from] = null;
    await enviarTextoCanal(from, `🚫 *Notificações desativadas com sucesso.*\n\nVocê não receberá mais:\n• Lembretes de vencimento\n• Avisos de pendência\n\nSe quiser voltar a receber, digite *ativar notificações*.`, contexto);
    return;
  }

  if (textoLimpo === "ativar notificações") {
    usuariosOptOut.delete(normalizarTelefoneBR(from));
    salvarOptOut();
    estadoUsuario[from] = null;
    await enviarTextoCanal(from, `✅ *Notificações reativadas com sucesso!*\n\nVocê voltará a receber lembretes e avisos normalmente. 📩`, contexto);
    return;
  }

  // 3. Menu
  if (["oi", "olá", "ola", "opa", "oii", "oiii", "bom dia", "boa tarde", "boa noite", "menu", "inicio", "início", "ola", "hello", "hi"].includes(texto)) {
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
    await registrarAcaoClienteChatwoot(from, "Opção 1 - Cotação pelo Aplicativo AVSEG", contexto.conversationId);
    await enviarTextoCanal(from, `📱 *Cotação pelo Aplicativo AVSEG*\n\nSegue o link do aplicativo AVSEG para download:\n\n🤖 Android:\nhttps://play.google.com/store/apps/details?id=com.avsegappcliente\n\n🍎 iOS:\nhttps://apps.apple.com/app/avseg-associado/id6645736685\n\n🔐 Seu usuário e senha são os números do seu CPF.\n\nApós instalar, acesse o app e siga o caminho:\n\n📋 Menu > Cotação\n\nFico à disposição em caso de dúvidas!`, contexto);
    return;
  }

  if (texto === "2") {
    await registrarAcaoClienteChatwoot(from, "Opção 2 - Pagamentos / 2ª via da participação mensal", contexto.conversationId);
    estadoUsuario[from] = "pagamento";
    await enviarTextoCanal(from, `💳 *Pagamentos — 2ª via da participação mensal*\n\nEnvie um dos dados abaixo:\n\n• 📋 CPF do titular\n• 🏢 CNPJ\n• 🚗 Placa do veículo`, contexto);
    return;
  }

  if (texto === "3") {
    await registrarAcaoClienteChatwoot(from, "Opção 3 - Acionar Assistência 24h", contexto.conversationId);
    estadoUsuario[from] = "assistencia";
    await enviarTextoCanal(from, `🚨 *Acione Assistência 24h*\n\nPara receber o atendimento adequado, selecione o que aconteceu:\n\n1️⃣ 🚨 Roubo ou Furto\n2️⃣ 🛠️ Pane, Guincho ou Chaveiro\n3️⃣ 💥 Colisão, Acidente ou Incêndio`, contexto);
    return;
  }

  if (texto === "4") {
    await registrarAcaoClienteChatwoot(from, "Opção 4 - Vistoria pelo Aplicativo AVSEG", contexto.conversationId);
    await enviarTextoCanal(from, `📱 *Vistoria pelo Aplicativo AVSEG*\nSegue o link do aplicativo AVSEG para download:\n\n🤖 Android:\nhttps://play.google.com/store/apps/details?id=com.avsegappcliente\n\n🍎 iOS:\nhttps://apps.apple.com/app/avseg-associado/id6645736685\n\n🔐 Seu usuário e senha são os números do seu CPF.\n\nApós instalar, acesse o app e siga o caminho:\n\n🔍 Menu > Vistoria > Iniciar\n\nFico à disposição em caso de dúvidas!`, contexto);
    return;
  }

  if (texto === "5") {
    await registrarAcaoClienteChatwoot(from, "Opção 5 - Solicitou atendimento humano", contexto.conversationId);
    if (!estaEmHorarioAtendimento()) {
      await enviarTextoCanal(from, `⏰ *Atendimento humano indisponível no momento.*\n\nNosso horário de atendimento é:\n\n🗓️ *Segunda a sexta:* 08:00 às 18:00\n🗓️ *Sábado:* 08:00 às 12:00\n🚫 *Domingo:* fechado\n\nDigite *menu* para acessar as opções automáticas.`, contexto);
      return;
    }
    modoHumano.add(from);
    estadoUsuario[from] = null;
    await enviarTextoCanal(from, `👨‍💻 *Atendimento Humano*\n\nVocê será atendido por um de nossos especialistas em instantes. ✅\n\nSe quiser voltar ao menu automático, basta digitar *menu*.`, contexto);

    if (temChatwootConfigurado()) {
      try {
        let convId = conversationId || obterUltimoCanal(from)?.conversationId;
        if (!convId) {
          convId = await criarConversaChatwoot(from, nomeCliente || "Cliente");
        } else {
          await abrirConversaHumanaChatwoot(convId);
        }
        if (convId) {
          atualizarUltimoCanal(from, { conversationId: convId });
          await enviarTextoChatwoot(convId, `🤖 Cliente solicitou atendimento humano via WhatsApp.\nNúmero: +${from}`, true);
          await enviarMensagemClienteChatwoot(convId, "Cliente solicitou atendimento humano pelo menu.");
        }
      } catch (erro) {
        console.error("❌ Erro ao criar conversa no Chatwoot:", erro.message);
      }
    }

    console.log(`👤 Atendimento humano ativado para ${from}`);
    return;
  }

  if (texto === "6") {
    await registrarAcaoClienteChatwoot(from, "Opção 6 - Avaliação de atendimento", contexto.conversationId);
    await iniciarAvaliacao(from, contexto);
    return;
  }

  if (["7", "encerrar", "finalizar", "sair"].includes(texto)) {
    estadoUsuario[from] = null;
    modoHumano.delete(from);
    await enviarTextoCanal(from, `✅ *Conversa encerrada.*\n\nFoi um prazer te atender! 😊\n\nQuando precisar, é só enviar *oi* ou *menu*. Estaremos aqui!\n\n🦁 *AVSEG Proteção Veicular*`, contexto);
    const canal = obterUltimoCanal(from);
    const convId = conversationId || canal?.conversationId;
    if (convId) await marcarConversaResolvidaChatwoot(convId);
    return;
  }

  // Pagamento (estado ativo)
  if (estadoUsuario[from] === "pagamento") {
    console.log(`💳 Estado pagamento ativo para ${from}: "${bodyText}"`);
    await processarPagamento(from, bodyText, contexto);
    return;
  }

  // Mensagens que registram e espelham no Chatwoot mas o bot não responde
  const respostasNaturais = [
    "obrigado", "obg", "valeu", "amei", "❤️", "😍", "🙏",
    "amém", "amem", "Amém", "Amem", "parabéns", "brigado",
    "show", "top", "okay", "kkk", "legal", "gratidão",
    "👍", "👏", "😊", "🙌",
    "certo", "entendi", "ok", "blz", "beleza", "perfeito", "ótimo", "massa",
  ];

  // Imagem — analisada com IA vision
  if (msgType === "image") {
    console.log(`🖼️ Imagem recebida: ${from}`);
    await processarImagemComIA(from, message, nomeCliente, contexto);
    return;
  }

  // Outras mídias — responde confirmando recebimento e escala para humano
  const ehMidia = ["video", "audio", "document", "sticker"].includes(msgType);
  if (ehMidia) {
    console.log(`📎 Mídia recebida (${msgType}): ${from}`);
    const dentroDoHorario = estaEmHorarioAtendimento();
    const msgMidia = dentroDoHorario
      ? `Obrigado pelo envio! 🤝 Um atendente irá verificar em breve.

*AVSEG Proteção Veicular*`
      : `Obrigado pelo envio! 🤝 Nosso horário de atendimento é:

🗓️ *Segunda a sexta:* 08h às 18h
🗓️ *Sábado:* 08h às 12h

Assim que retornarmos, seu envio será verificado. ✅

*AVSEG Proteção Veicular*`;

    await enviarTextoCanal(from, msgMidia, contexto);
    // Escala para humano automaticamente
    modoHumano.add(from);
    estadoUsuario[from] = null;
    if (temChatwootConfigurado()) {
      try {
        // Garante que existe uma conversa — cria se não existir
        let convId = contexto.conversationId || obterUltimoCanal(from)?.conversationId;
        if (!convId) {
          convId = await criarConversaChatwoot(from, nomeCliente || "Associado");
          if (convId) atualizarUltimoCanal(from, { origem: "meta", conversationId: convId });
        } else {
          await abrirConversaHumanaChatwoot(convId);
        }

        if (convId) {
          atualizarUltimoCanal(from, { conversationId: convId });

          // Tenta enviar o anexo real no Chatwoot
          try {
            const anexoEnviado = await enviarAnexoClienteChatwoot(convId, message);
            if (!anexoEnviado) {
              // Fallback: nota privada se não conseguir enviar o anexo
              await enviarTextoChatwoot(convId, `📎 Associado enviou mídia (${msgType}). Aguardando verificação do atendente.

📱 Número: +${from}`, true);
            }
          } catch (_) {
            await enviarTextoChatwoot(convId, `📎 Associado enviou mídia (${msgType}). Aguardando verificação do atendente.

📱 Número: +${from}`, true);
          }
        }
      } catch (erroChat) {
        console.error("❌ Erro ao escalar mídia para Chatwoot:", erroChat.message);
      }
    }
    return;
  }

  // Reaction — ignora silenciosamente
  if (msgType === "reaction") {
    console.log(`⏭️ Reaction ignorado: ${from}`);
    return;
  }

  const ehRespostaNatural =
    respostasNaturais.some((t) => texto.toLowerCase().includes(t));

  if (ehRespostaNatural) {
    console.log(`⏭️ Mensagem ignorada pelo bot (natural): ${from}`);
    return;
  }

  // =============================================================================
  // IA — Fallback inteligente
  // =============================================================================
  await processarComIA(from, bodyText, msgType, message, contexto);
}

// =============================================================================
// IA — FUNÇÃO PRINCIPAL
// =============================================================================
async function processarComIA(from, bodyText, msgType, message, contexto = {}) {
  try {
    const ehImagem = msgType === "image" || msgType === "document";
    const ehAudio = msgType === "audio";

    // Monta conteúdo para a IA
    let mensagemCliente = String(bodyText || "").trim();
    if (msgType === "image") {
      mensagemCliente = `[Associado enviou uma imagem/foto${mensagemCliente ? `: ${mensagemCliente}` : ""}]`;
    } else if (msgType === "document") {
      mensagemCliente = `[Associado enviou um documento PDF${mensagemCliente ? `: ${mensagemCliente}` : ""}]`;
    } else if (msgType === "video") {
      mensagemCliente = `[Associado enviou um vídeo${mensagemCliente ? `: ${mensagemCliente}` : ""}]`;
    } else if (ehAudio) {
      mensagemCliente = `[Associado enviou um áudio${mensagemCliente ? `: ${mensagemCliente}` : ""}]`;
    }
    if (!mensagemCliente) mensagemCliente = `[Mensagem do tipo ${msgType}]`;

    const systemPrompt = `Você é um assistente virtual da AVSEG Proteção Veicular, empresa de proteção de veículos em Feira de Santana, Bahia.

Você recebe mensagens de associados que responderam a notificações automáticas (lembretes de vencimento, cobranças) ou entraram em contato pelo WhatsApp.

Seu papel é classificar a intenção do associado e responder de forma natural, cordial e profissional em português brasileiro.

## REGRAS DE CLASSIFICAÇÃO

Responda SEMPRE em JSON com este formato exato:
{
  "intencao": "TIPO",
  "resposta": "Texto da resposta para o cliente",
  "acao": "ACAO",
  "dados": "placa ou CPF extraído (apenas para BUSCAR_BOLETO, senão null)"
}

### Tipos de intenção e ações:

**PAGAMENTO_CONFIRMADO** → Associado diz que JÁ pagou, JÁ efetuou o pagamento, JÁ enviou comprovante de PAGAMENTO (ação concluída). Atenção: comprovante de pagamento é diferente de vídeo de vistoria.
- acao: "NENHUMA"
- resposta: Agradeça pelo aviso sem confirmar que o pagamento foi recebido. Informe que pagamentos podem levar até 2 dias úteis para serem identificados no sistema e que assim que processado tudo fica em dia automaticamente. Não use palavras como "recebemos", "confirmamos" ou "já está registrado".

**OFERTA_COMPROVANTE** → Associado diz que TEM o comprovante de PAGAMENTO e QUER enviar, mas ainda não enviou (ex: "tenho o comprovante", "posso enviar", "vou mandar", "estou com o comprovante")
- acao: "NENHUMA"
- resposta: Solicite que envie o comprovante para que possamos verificar e registrar o pagamento.

**VISTORIA_ENVIANDO** → Associado enviou vídeo ou foto do veículo especificamente para vistoria (não é comprovante de pagamento nem documento PDF)
- acao: "HUMANO"
- resposta: Agradeça pelo envio e informe que vai conectar com um atendente para verificar e dar continuidade ao processo de vistoria.

**QUER_BOLETO_SEM_DADOS** → Associado pede 2ª via, boleto, link de pagamento, como pagar, SEM informar placa ou CPF
- acao: "PEDIR_DADOS"
- resposta: Peça a placa ou CPF do associado para buscar a participação mensal.

**QUER_BOLETO_COM_DADOS** → Associado pede boleto E já informa a placa ou CPF na mesma mensagem (ex: "minha placa é ABC1234", "preciso pagar, CPF 123")
- acao: "BUSCAR_BOLETO"
- resposta: "" (vazio, o sistema vai buscar automaticamente)
- dados: extraia a placa ou CPF mencionado

**COTACAO** → Associado quer fazer cotação, saber o preço, tem interesse em contratar
- acao: "NENHUMA"  
- resposta: Oriente a acessar a opção *1* no menu ou digitar *menu*.

**VISTORIA** → Associado pergunta sobre vistoria, como fazer, prazo
- acao: "NENHUMA"
- resposta: Oriente a acessar a opção *4* no menu ou digitar *menu*.

**VEICULO_INCORRETO** → Associado diz que a placa não é dele, vendeu o veículo, veículo de outra pessoa
- acao: "HUMANO"
- resposta: Demonstre empatia e informe que vai conectar com um atendente para resolver.

**NOME_INCORRETO** → Associado indica que o nome ou cadastro identificado não é dele (ex: "esse não sou eu", "nome errado", "não é minha placa", "você tá me confundindo")
- acao: "LIMPAR_NOME"
- resposta: Peça desculpas pela confusão e solicite placa ou CPF para localizar o cadastro correto.

**RECLAMACAO** → Associado reclama, está frustrado, insatisfeito, questiona cobrança indevida
- acao: "HUMANO"
- resposta: Demonstre empatia, peça desculpas e informe que vai conectar com um atendente.

**CANCELAMENTO** → Associado quer cancelar, encerrar o plano
- acao: "HUMANO"
- resposta: Demonstre empatia e informe que vai conectar com um atendente especializado.

**SINISTRO** → Associado teve acidente, roubo, furto, colisão, incêndio — mas está fora do submenu de assistência
- acao: "NENHUMA"
- resposta: Oriente a digitar *menu* e escolher a opção *3* (Assistência 24h).

**DUVIDA_HORARIO** → Associado pergunta sobre horário de atendimento, até que horas pode enviar, quando abre, quando fecha
- acao: "NENHUMA"
- resposta: Informe o horário de atendimento (Segunda a sexta 08h às 18h, Sábado 08h às 12h). Diga que mensagens e comprovantes podem ser enviados a qualquer hora pelo WhatsApp.

**DUVIDA_GERAL** → Dúvida do associado sobre a proteção, cobertura, funcionamento
- acao: "HUMANO"
- resposta: Informe que vai conectar com um atendente para esclarecer.

**AGRADECIMENTO** → "obrigado", "valeu", elogios simples
- acao: "NENHUMA"
- resposta: Resposta breve e cordial.

**OUTRO** → Qualquer coisa que não se encaixe acima
- acao: "NENHUMA"
- resposta: Responda de forma amigável e sugira digitar *menu*.

## INFORMAÇÕES DA EMPRESA
- Horário de atendimento das atendentes humanas: Segunda a sexta 08h às 18h, Sábado 08h às 12h, Domingo fechado
- O bot funciona 24 horas, mas atendentes humanas só respondem no horário comercial
- Comprovantes, vídeos e mensagens podem ser enviados a qualquer hora pelo WhatsApp — serão verificados no próximo horário comercial
- O processamento de pagamentos pode levar até 2 dias úteis
- Após 3 dias de atraso no pagamento, é necessária nova vistoria para reativar a proteção
- Para dúvidas sobre cobertura, sinistro ou cancelamento, sempre escalar para humano

## REGRAS DE RESPOSTA
- Máximo 3 linhas por resposta
- Tom cordial, humano, sem robotismo
- Nunca invente informações sobre valores, datas ou cobertura
- Nunca prometa algo que não sabe se é verdade
- Assine como: *AVSEG Proteção Veicular*
- Responda APENAS o JSON, sem texto antes ou depois`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          { role: "user", content: mensagemCliente },
          { role: "assistant", content: "{" },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Erro na API Anthropic:", data);
      await fallbackSimples(from, contexto);
      return;
    }

    let resultado;
    try {
      const textoRaw = data?.content?.[0]?.text?.trim() || "}";
      // Adiciona o { que foi usado como prefill
      const textoCompleto = "{" + textoRaw;
      const textoLimpo = textoCompleto.replace(/```json|```/g, "").trim();
      resultado = JSON.parse(textoLimpo);
    } catch (erroParse) {
      console.error("❌ Erro ao parsear resposta da IA:", erroParse.message);
      await fallbackSimples(from, contexto);
      return;
    }

    const { intencao, resposta, acao } = resultado;

    console.log(`🤖 IA [${from}]: intenção=${intencao} ação=${acao}`);

    // Registra no log
    registrarLogConversa({
      telefone: normalizarTelefoneBR(from),
      nome: "Bot IA",
      origem: "bot_ia",
      tipo: "ia_resposta",
      mensagem: resposta || "",
      mensagemOriginal: bodyText || `[${msgType}]`,
      intencao: intencao || "OUTRO",
    });

    // Executa ação
    if (acao === "PEDIR_DADOS") {
      // Coloca no estado de pagamento para processar placa/CPF na próxima mensagem
      estadoUsuario[from] = "pagamento";
    }

    if (acao === "BUSCAR_BOLETO") {
      // Cliente já informou a placa/CPF — processa direto sem responder da IA
      const dadosExtraidos = resultado.dados || bodyText;
      estadoUsuario[from] = "pagamento";
      await processarPagamento(from, dadosExtraidos, contexto);
      return;
    }

    if (acao === "LIMPAR_NOME") {
      delete nomesAssociados[from];
      estadoUsuario[from] = null;
    }

    if (acao === "HUMANO") {
      // Avisa o cliente e abre no Chatwoot
      if (resposta) await enviarTextoCanal(from, resposta, contexto);

      modoHumano.add(from);
      estadoUsuario[from] = null;

      // Abre conversa no Chatwoot
      if (temChatwootConfigurado()) {
        try {
          let convId = contexto.conversationId || obterUltimoCanal(from)?.conversationId;
          if (!convId) {
            convId = await criarConversaChatwoot(from, "Associado");
          } else {
            await abrirConversaHumanaChatwoot(convId);
          }
          if (convId) {
            atualizarUltimoCanal(from, { conversationId: convId });
            await enviarTextoChatwoot(
              convId,
              `🤖 *IA escalou para humano*\n\nIntenção identificada: *${intencao}*\nMensagem do associado: "${bodyText || `[${msgType}]`}"\n\n📱 Número: +${from}`,
              true,
            );
          }
        } catch (erroChat) {
          console.error("❌ Erro ao abrir Chatwoot via IA:", erroChat.message);
        }
      }
      return;
    }

    // Para outras ações, envia a resposta da IA
    if (resposta) {
      await enviarTextoCanal(from, resposta, contexto);
    }

  } catch (erro) {
    console.error("❌ Erro ao processar com IA:", erro.message);
    await fallbackSimples(from, contexto);
  }
}

async function fallbackSimples(from, contexto = {}) {
  await enviarTextoCanal(
    from,
    `Olá! Recebi sua mensagem. 😊\n\nPara acessar todas as opções, digite *menu*.\n\n🦁 *AVSEG Proteção Veicular*`,
    contexto,
  );
}

// =============================================================================
// EVENTOS — META
// =============================================================================
app.on("wa_message", async ({ from, bodyText, msgType, message, nomeCliente, midiaDashboard }) => {
  ultimaMensagemRecebida = Date.now(); // Atualiza watchdog
  await processarMensagem({ from, bodyText, origem: "meta", msgType, message, nomeCliente, midiaDashboard });
});

// =============================================================================
// EVENTOS — CHATWOOT
// =============================================================================
// Ativa modo humano automaticamente quando atendente responde pelo Chatwoot
app.on("ativar_modo_humano", ({ telefone, conversationId }) => {
  const numero = normalizarTelefoneBR(telefone);
  if (!numero) return;

  if (!modoHumano.has(numero)) {
    modoHumano.add(numero);
    estadoUsuario[numero] = null;
    console.log(`👤 Modo humano ativado automaticamente para ${numero} (atendente respondeu)`);
  }

  if (conversationId) {
    atualizarUltimoCanal(numero, { conversationId });
  }
});

// Libera modo humano automaticamente quando atendente resolve a conversa no Chatwoot
app.on("liberar_modo_humano", ({ telefone }) => {
  const numero = normalizarTelefoneBR(telefone);
  if (!numero) return;

  if (modoHumano.has(numero)) {
    modoHumano.delete(numero);
    estadoUsuario[numero] = null;
    console.log(`✅ Modo humano liberado automaticamente para ${numero} (conversa resolvida)`);
  }
});

app.on("chatwoot_message", async ({ from, bodyText, conversationId, raw }) => {
  atualizarUltimoCanal(from, {
    origem: "chatwoot",
    conversationId,
    inboxId: raw?.conversation?.inbox_id || null,
    contactId: raw?.sender?.id || raw?.contact?.id || null,
  });

  if (!modoHumano.has(from)) {
    console.log(`⏭️ Mensagem do Chatwoot ignorada: ${from} não está em atendimento humano.`);
    return;
  }

  if (!bodyText || !String(bodyText).trim()) {
    console.log("⏭️ Mensagem vazia do Chatwoot ignorada.");
    return;
  }

  try {
    await enviarTexto(from, bodyText);
    registrarLogConversa({ telefone: from, nome: "Atendente", origem: "atendente", tipo: "text", mensagem: bodyText, conversationId });
    console.log(`✅ Mensagem do atendente enviada para WhatsApp: ${from}`);
  } catch (erro) {
    console.error("❌ Erro ao enviar mensagem do Chatwoot para WhatsApp:", erro.response?.data || erro.message);
  }
});

// =============================================================================
// CRON — NOTIFICAÇÕES DIÁRIAS
// =============================================================================
function ehDiaDePico() {
  const hoje = new Date();
  const diaBrasil = new Date(hoje.getTime() - 3 * 60 * 60 * 1000).getDate();
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
      const notificacoes = Array.isArray(resposta.data?.notificacoes) ? resposta.data.notificacoes : [];

      console.log(`📋 Total de notificações: ${notificacoes.length}`);
      console.log("📊 Resumo:", JSON.stringify(resposta.data?.resumo || {}));

      for (const item of notificacoes) {
        const telefone = normalizarTelefoneBR(item?.telefone || "");
        if (!telefone) continue;

        if (!podeEnviar(telefone)) {
          console.log(`🧪 TEST_MODE ativo: template bloqueado para ${telefone}`);
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
        const controleEnvio = podeEnviarTemplateSeguro(item, telefone, templateName);

        if (!controleEnvio.permitido) {
          console.log(`⏭️ Template bloqueado: ${controleEnvio.motivo}`);
          continue;
        }

        try {
          const urlBotao = montarUrlBotaoTemplate(item);
          await enviarTemplate(telefone, templateName, parametros, urlBotao);
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
          console.log(`⏳ Aguardando ${Math.round(espera / 1000)}s antes do próximo envio...`);
          await delay(espera);
        } catch (erro) {
          console.error(`❌ Erro ao enviar template ${templateName} para ${telefone}:`, erro.response?.data || erro.message);
        }
      }

      console.log("✅ Rotina de notificações concluída.");
    } catch (erro) {
      console.error("❌ Erro na rotina de notificações:", erro.response?.data || erro.message);
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
      ? (avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length).toFixed(2)
      : null;
  res.json({ total: avaliacoes.length, media, avaliacoes });
});

app.get("/modo-humano", protegerRotaInterna, (req, res) => {
  res.json({ total: modoHumano.size, numeros: [...modoHumano] });
});

app.get("/canais", protegerRotaInterna, (req, res) => {
  res.json({ total: Object.keys(ultimoCanalPorNumero).length, canais: ultimoCanalPorNumero });
});

console.log(`🤖 Bot iniciado. TEST_MODE=${TEST_MODE ? "ON" : "OFF"} | CHATWOOT=${temChatwootConfigurado() ? "ON" : "OFF"} | CHAT_AVSEG=${temChatAvsegConfigurado() ? "ON" : "OFF"}`);

// =============================================================================
// WATCHDOG — reinicia automaticamente se ficar sem receber mensagens por 30min
// =============================================================================
let ultimaMensagemRecebida = Date.now();
const WATCHDOG_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutos

setInterval(() => {
  const agora = Date.now();
  const semMensagem = agora - ultimaMensagemRecebida;

  // Só verifica em horário comercial (08h-22h Brasil)
  const horaBrasil = (new Date().getUTCHours() - 3 + 24) % 24;
  if (horaBrasil < 8 || horaBrasil >= 22) return;

  if (semMensagem > WATCHDOG_TIMEOUT_MS) {
    console.log(`⚠️ WATCHDOG: sem mensagens há ${Math.round(semMensagem / 60000)} minutos. Reiniciando processo...`);
    process.exit(0); // PM2 reinicia automaticamente
  }
}, 5 * 60 * 1000); // Verifica a cada 5 minutos
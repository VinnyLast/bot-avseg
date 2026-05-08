require("dotenv").config();

const express = require("express");
const axios = require("axios");
const dayjs = require("dayjs");
const fs = require("fs");
const path = require("path");

const ARQUIVO_I9_PLACAS = path.join(__dirname, "i9_placas.json");
const ARQUIVO_LOG_CONSULTAS = path.join(__dirname, "logs_consultas.json");
const ARQUIVO_LOG_NOTIFICACOES = path.join(__dirname, "logs_notificacoes.json");
const ARQUIVO_LOG_AVALIACOES = path.join(__dirname, "logs_avaliacoes.json");
const ARQUIVO_OPTOUT = path.join(__dirname, "usuarios_optout.json");
const ARQUIVO_ENVIOS = path.join(__dirname, "envios_templates.json");

function registrarLogNotificacao(item) {
  adicionarLog(ARQUIVO_LOG_NOTIFICACOES, item);
}

function carregarJson(caminho, padrao) {
  try {
    if (!fs.existsSync(caminho)) return padrao;
    const conteudo = fs.readFileSync(caminho, "utf8");
    if (!conteudo.trim()) return padrao;
    return JSON.parse(conteudo);
  } catch {
    return padrao;
  }
}

function salvarJson(caminho, dados) {
  fs.writeFileSync(caminho, JSON.stringify(dados, null, 2));
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
function adicionarLog(caminho, item) {
  const logs = carregarJson(caminho, []);
  logs.unshift({
    ...item,
    data: new Date().toISOString(),
  });

  salvarJson(caminho, logs.slice(0, 1000));
}

const app = express();
app.use(express.static("public"));
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 10000);

// ── Credenciais internas ──────────────────────────────────────────────────────
const TOKEN_I9 = process.env.TOKEN_I9;
const I9_BOLETO_URL = process.env.I9_BOLETO_URL;
const SOUTH_BASE_URL = process.env.SOUTH_BASE_URL;
const SOUTH_TOKEN = process.env.SOUTH_TOKEN;

// ── Credenciais WhatsApp (Meta Cloud API) ─────────────────────────────────────
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ── Segurança interna ─────────────────────────────────────────────────────────
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// =============================================================================
// VALIDAÇÃO DE ENV
// =============================================================================
function validarEnv() {
  const obrigatorias = [
    "TOKEN_I9",
    "I9_BOLETO_URL",
    "SOUTH_BASE_URL",
    "SOUTH_TOKEN",
    "WHATSAPP_TOKEN",
    "WHATSAPP_PHONE_ID",
    "WHATSAPP_VERIFY_TOKEN",
    "INTERNAL_API_KEY",
  ];

  const faltando = obrigatorias.filter((nome) => !process.env[nome]);

  if (faltando.length) {
    console.error("❌ Variáveis de ambiente ausentes:", faltando.join(", "));
    process.exit(1);
  }
}

validarEnv();

// =============================================================================
// MIDDLEWARES
// =============================================================================
function protegerRotaInterna(req, res, next) {
  const chave = req.headers["x-api-key"];
  if (!INTERNAL_API_KEY || chave !== INTERNAL_API_KEY) {
    return res.status(401).json({ status: "erro", mensagem: "Não autorizado" });
  }
  next();
}

function extrairErro(erro) {
  return erro.response?.data || erro.message || "Erro desconhecido";
}

function normalizarDocumento(documento) {
  return String(documento || "").replace(/\D/g, "");
}

function normalizarPlaca(placa) {
  return String(placa || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizarTelefoneBR(valor) {
  let digitos = String(valor || "").replace(/\D/g, "");
  if (!digitos) return "";

  if (!digitos.startsWith("55")) {
    digitos = `55${digitos}`;
  }

  // Inserção do nono dígito para DDDs que ainda não têm
  if (digitos.length === 12) {
    const parte1 = digitos.slice(0, 4);
    const parte2 = digitos.slice(4);
    digitos = `${parte1}9${parte2}`;
  }

  return digitos;
}

function formatarDataBR(data) {
  if (!data || data === "ND") return "ND";
  try {
    const texto = String(data);
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
      const [ano, mes, dia] = texto.split("-");
      return `${dia}/${mes}/${ano}`;
    }
    return texto;
  } catch {
    return String(data);
  }
}

function formatarValorBR(valor) {
  if (valor === null || valor === undefined || valor === "" || valor === "ND") {
    return "ND";
  }
  const numero = Number(String(valor).replace(",", "."));
  if (Number.isNaN(numero)) return String(valor);
  return numero.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

// ── Health checks ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("API do bot funcionando 🚀"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// WEBHOOK — verificação da Meta (GET)
// =============================================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado pela Meta");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Falha na verificação do webhook");
  return res.sendStatus(403);
});

// =============================================================================
// WEBHOOK E CHATWOOT— recebimento de mensagens (POST)
// =============================================================================
app.post("/webhook", (req, res) => {
  console.log("WEBHOOK RECEBIDO");
  console.log(JSON.stringify(req.body, null, 2));

  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== "whatsapp_business_account") return;

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  if (!value?.messages?.length) return;

  const message = value.messages[0];
  const from = normalizarTelefoneBR(message.from);
  const msgType = message.type;
  const bodyText = message.text?.body?.trim() || "";

  if (!from) {
    console.warn("⚠️ Número inválido recebido no webhook");
    return;
  }

  console.log(`📩 Mensagem de ${from} [${msgType}]`);

  app.emit("wa_message", { from, bodyText, msgType, message, value });
});
app.post("/chatwoot-bot", async (req, res) => {
  try {
    const body = req.body;

    console.log("📩 WEBHOOK CHATWOOT:");
    console.log(JSON.stringify(body, null, 2));

    const event = body.event;
    const messageType = body.message_type || body.message?.message_type;
    const content = body.content || body.message?.content || "";

    const conversation = body.conversation || body.message?.conversation || {};
    const contact =
      body.contact ||
      body.sender ||
      conversation.contact ||
      body.conversation?.contact ||
      {};

    const senderType =
      body.sender?.type || body.message?.sender?.type || body.sender_type || "";

    // Ignora notas privadas
    if (body.private === true || body.message?.private === true) {
      return res.status(200).json({
        ok: true,
        ignored: "private_note",
      });
    }

    // Evita loop:
    // mensagens incoming no Chatwoot são apenas o espelho do que já veio pela Meta.
    // Se processar incoming aqui, ele manda de volta para o bot e cria repetição.
    if (messageType === "incoming") {
      return res.status(200).json({
        ok: true,
        ignored: "incoming_chatwoot_ignored_to_prevent_loop",
        event,
        senderType,
      });
    }

    const phoneRaw =
      contact.phone_number ||
      contact.phone ||
      conversation.meta?.sender?.phone_number ||
      body.conversation?.meta?.sender?.phone_number ||
      "";

    const telefone = normalizarTelefoneBR(phoneRaw);

    if (!telefone || !content) {
      return res.status(200).json({
        ok: true,
        ignored: "sem telefone ou conteúdo",
      });
    }

    // Mensagem do atendente no Chatwoot -> envia para WhatsApp
    if (messageType === "outgoing") {
      await enviarTexto(telefone, content);

      return res.status(200).json({
        ok: true,
        sent_to_whatsapp: telefone,
      });
    }

    return res.status(200).json({
      ok: true,
      ignored: `message_type ${messageType}`,
    });
  } catch (erro) {
    console.error(
      "❌ Erro no webhook Chatwoot:",
      erro.response?.data || erro.message,
    );

    return res.status(500).json({
      ok: false,
      erro: erro.message,
    });
  }
});

// =============================================================================
// ENVIO DE MENSAGENS
// =============================================================================
async function enviarTexto(to, texto) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );
    console.log(`✅ TEXTO ENVIADO para ${to}:`, response.data);
  } catch (erro) {
    console.error(`❌ ERRO META (texto):`, erro.response?.data || erro.message);
  }
}

async function enviarImagem(to, imageUrl, caption = "") {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: imageUrl, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );
    console.log(`✅ IMAGEM ENVIADA para ${to}:`, response.data);
  } catch (erro) {
    console.error(
      `❌ ERRO META (imagem):`,
      erro.response?.data || erro.message,
    );
  }
}

// =============================================================================
// MENSAGENS
// =============================================================================
function montarMensagemBoleto(veiculo) {
  const nome = veiculo.nome || "Cliente";
  const placa = veiculo.placa || "ND";
  const vencimento = formatarDataBR(veiculo.vencimento);
  const valor = formatarValorBR(veiculo.valor);
  const url = veiculo.url || "ND";
  let msg = `💳 *Boleto encontrado com sucesso!*\n\n`;
  msg += `👤 *Associado:* ${nome}\n`;
  msg += `🚗 *Placa:* ${placa}\n`;
  msg += `📅 *Vencimento:* ${vencimento}\n`;
  msg += `💰 *Valor:* ${valor}\n`;

  if (url && url !== "ND") {
    msg += `\n🔗 *Acessar boleto:*\n${url}`;
  }

  return msg;
}

function montarMensagemSemResultado(entrada) {
  return `❌ *Nenhum boleto encontrado* para *${entrada || "informado"}*.\n\nConfira os dados e tente novamente.`;
}

// =============================================================================
// I9 — CONSULTA PADRÃO (segunda via)
// =============================================================================
function normalizarVeiculoI9(v) {
  return {
    matricula: v?.matricula || v?.Matricula || "ND",
    placa: v?.placa || v?.Placa || "ND",
    vencimento:
      v?.vencimento ||
      v?.Vencimento ||
      v?.data_vencimento ||
      v?.DataVencimento ||
      "ND",
    valor: v?.valor || v?.Valor || v?.valor_boleto || v?.ValorBoleto || "ND",
    status: v?.status || v?.Status || "ND",
    url: v?.url || v?.Url || v?.link || v?.Link || "ND",
    linhadigitavel:
      v?.linhadigitavel ||
      v?.linha_digitavel ||
      v?.LinhaDigitavel ||
      v?.linhaDigitavel ||
      "ND",
    nome: v?.nome || v?.Nome || "Cliente",
    documento: v?.documento || v?.Documento || "ND",
    telefone: normalizarTelefoneBR(v?.telefone || v?.Telefone || ""),
  };
}

function temResultadoI9(dados) {
  if (!Array.isArray(dados?.veiculos) || dados.veiculos.length === 0)
    return false;
  return dados.veiculos.some(
    (v) =>
      (v.url && v.url !== "ND") ||
      (v.linhadigitavel && v.linhadigitavel !== "ND") ||
      (v.vencimento && v.vencimento !== "ND") ||
      (v.valor && v.valor !== "ND"),
  );
}

function adaptarResultadoI9(dadosI9) {
  const originais = Array.isArray(dadosI9?.veiculos) ? dadosI9.veiculos : [];
  const normalizados = originais.map(normalizarVeiculoI9);
  const validos = normalizados.filter(
    (v) =>
      (v.url && v.url !== "ND") ||
      (v.linhadigitavel && v.linhadigitavel !== "ND") ||
      (v.vencimento && v.vencimento !== "ND") ||
      (v.valor && v.valor !== "ND"),
  );

  if (validos.length > 0) {
    return {
      status: "sucesso",
      mensagem: dadosI9?.mensagem || "Boleto encontrado no I9",
      veiculos: validos,
      mensagemWhatsapp: montarMensagemBoleto(validos[0]),
    };
  }

  return {
    status: "erro",
    mensagem:
      dadosI9?.mensagem ||
      "Cadastro encontrado no I9, mas sem boleto disponível",
    veiculos: [],
    mensagemWhatsapp:
      "❌ Cadastro encontrado, mas não há boleto disponível no momento.",
  };
}

async function consultarBoletoI9({ tipo, cpf, cnpj, placa }) {
  const payload = {
    token: TOKEN_I9,
    tipo: tipo || 1,
    cpf: normalizarDocumento(cpf),
    cnpj: normalizarDocumento(cnpj),
    placa: normalizarPlaca(placa),
  };

  const resposta = await axios.post(I9_BOLETO_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  return resposta.data;
}

// =============================================================================
// I9 — BUSCA DE VENCIMENTOS PARA NOTIFICAÇÕES AUTOMÁTICAS
// =============================================================================

/**
 * Converte a data de vencimento do I9 (DD/MM/YYYY ou YYYY-MM-DD) para dayjs.
 */
function parsearDataVencimentoI9(vencimento) {
  if (!vencimento || vencimento === "ND") return null;
  const texto = String(vencimento).trim();

  // Formato DD/MM/YYYY (padrão retornado pelo I9)
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(texto)) {
    const [dia, mes, ano] = texto.split("/");
    return dayjs(`${ano}-${mes}-${dia}`);
  }

  // Formato ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return dayjs(texto);
  }

  return null;
}

/**
 * Dado um array de placas, consulta o I9 e retorna apenas os veículos
 * cujo vencimento bate com a dataAlvo.
 */
async function i9BuscarVencimentosPorPlacas(placas, dataAlvo, tipoNotificacao) {
  const dataAlvoDayjs = dayjs(dataAlvo);
  const resultados = [];
  const LOTE = 5;

  for (let i = 0; i < placas.length; i += LOTE) {
    const lote = placas.slice(i, i + LOTE);

    await Promise.all(
      lote.map(async (placa) => {
        try {
          const dados = await consultarBoletoI9({ tipo: 1, placa });
          const veiculos = Array.isArray(dados?.veiculos) ? dados.veiculos : [];

          for (const v of veiculos) {
            const norm = normalizarVeiculoI9(v);
            const dataVenc = parsearDataVencimentoI9(norm.vencimento);

            if (!dataVenc) continue;
            if (!dataVenc.isSame(dataAlvoDayjs, "day")) continue;
            if (norm.url === "ND" && norm.linhadigitavel === "ND") continue;

            resultados.push({
              nome: norm.nome,
              telefone: norm.telefone,
              placa: norm.placa || placa,
              vencimento: norm.vencimento,
              valor: norm.valor,
              url: norm.url,
              linhadigitavel: norm.linhadigitavel,
              matricula: norm.matricula,
              tipo: tipoNotificacao,
              sistema: "i9",
            });
          }
        } catch (erro) {
          console.warn(
            `⚠️ I9 vencimentos — erro na placa ${placa}:`,
            extrairErro(erro),
          );
        }
      }),
    );
  }

  return resultados;
}

/**
 * Busca vencimentos no I9 para uma data-alvo.
 * Estratégia: obtém as placas pelo South (que já tem listagem por data)
 * e cruza com o I9 individualmente.
 */
function carregarPlacasI9() {
  const placas = carregarJson(ARQUIVO_I9_PLACAS, []);

  if (!Array.isArray(placas)) return [];

  return [
    ...new Set(
      placas
        .map((p) => normalizarPlaca(p))
        .filter(Boolean)
    ),
  ];
}
async function i9BuscarVencimentos(dataAlvo, tipoNotificacao) {
  try {
    const placas = carregarPlacasI9();

    if (!placas.length) {
      console.log(`ℹ️ I9 [${tipoNotificacao}]: nenhuma placa cadastrada em i9_placas.json`);
      return [];
    }

    console.log(
      `🔍 I9 [${tipoNotificacao}]: consultando ${placas.length} placa(s) próprias — ${dataAlvo}`
    );

    const resultados = await i9BuscarVencimentosPorPlacas(
      placas,
      dataAlvo,
      tipoNotificacao
    );

    console.log(
      `✅ I9 [${tipoNotificacao}]: ${resultados.length} resultado(s)`
    );

    return resultados;
  } catch (erro) {
    console.error(
      `❌ Erro i9BuscarVencimentos [${tipoNotificacao}]:`,
      extrairErro(erro)
    );
    return [];
  }
}
// =============================================================================
// SOUTH
// =============================================================================
function temResultadoSouth(dados) {
  return Boolean(dados?.veiculos?.length);
}

async function southBuscarAssociado(placaOuDocumento) {
  try {
    const valor = String(placaOuDocumento || "").trim();
    if (!valor) return null;

    const resposta = await axios.get(
      `${SOUTH_BASE_URL}VendasCarros/DadosAssociado/${encodeURIComponent(valor)}`,
      {
        headers: { Accept: "application/json", Authorization: SOUTH_TOKEN },
        timeout: 15000,
      },
    );

    return resposta.data;
  } catch (erro) {
    console.log("ERRO ASSOCIADO SOUTH:", erro.response?.data || erro.message);
    return null;
  }
}

async function southBuscarAniversariantes() {
  const hoje = dayjs();
  const mes = hoje.month() + 1;
  const dia = hoje.date();

  try {
    const resposta = await axios.get(
      `${SOUTH_BASE_URL}Clientes/aniversariantes`,
      {
        params: { Mes: mes, Dia: dia },
        headers: { Authorization: SOUTH_TOKEN, Accept: "application/json" },
        timeout: 15000,
      },
    );

    const dados = resposta.data;
    const lista = Array.isArray(dados)
      ? dados
      : Array.isArray(dados?.dados)
        ? dados.dados
        : Array.isArray(dados?.Dados)
          ? dados.Dados
          : Array.isArray(dados?.Result)
            ? dados.Result
            : [];

    return lista.map((cli) => ({
      nome: cli.IndividuosNome || "Associado",
      telefone: normalizarTelefoneBR(
        cli.IndividuosContatosDdd && cli.IndividuosContatosTelefone
          ? `55${cli.IndividuosContatosDdd}${cli.IndividuosContatosTelefone}`
          : cli.IndividuosContatosTelefone || "",
      ),
      tipo: "aniversario",
      dataNascimento: cli.IndividuosDataNascimento || "",
      sistema: "south",
    }));
  } catch (erro) {
    console.error(
      "❌ Erro Aniversariantes:",
      erro.response?.status,
      erro.response?.data || erro.message,
    );
    return [];
  }
}

async function southBuscarVencimentos(dataAlvo, tipoNotificacao) {
  const formatosData = [
    dayjs(dataAlvo).format("YYYY-MM-DD"),
    dayjs(dataAlvo).format("DD/MM/YYYY"),
  ];

  const payloads = [];
  for (const dataFormatada of formatosData) {
    payloads.push({
      DataInicial: dataFormatada,
      DataFinal: dataFormatada,
      Situacao: 1,
      FormaPagamento: 1,
      count: 100,
      page: 1,
    });
    payloads.push({
      DataInicial: dataFormatada,
      DataFinal: dataFormatada,
      Situacao: 4,
      count: 100,
      page: 1,
    });
    payloads.push({
      DataInicial: dataFormatada,
      DataFinal: dataFormatada,
      FormaPagamento: 1,
      count: 100,
      page: 1,
    });
    payloads.push({
      DataInicial: dataFormatada,
      DataFinal: dataFormatada,
      count: 100,
      page: 1,
    });
  }

  for (const payloadBase of payloads) {
    let pagina = 1;
    const todos = [];

    while (true) {
      const payload = { ...payloadBase, page: pagina };

      try {
        const resposta = await axios.post(
          `${SOUTH_BASE_URL}Boletos/lista`,
          payload,
          {
            headers: {
              Authorization: SOUTH_TOKEN,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            timeout: 15000,
          },
        );

        const dadosBrutos = resposta.data;
        const lista = Array.isArray(dadosBrutos)
          ? dadosBrutos
          : Array.isArray(dadosBrutos?.dados)
            ? dadosBrutos.dados
            : Array.isArray(dadosBrutos?.Dados)
              ? dadosBrutos.Dados
              : Array.isArray(dadosBrutos?.Result)
                ? dadosBrutos.Result
                : [];

        if (!lista.length) break;
        todos.push(...lista);
        if (lista.length < 100) break;
        pagina++;
      } catch (erro) {
        const status = erro.response?.status;
        const dadosErro = erro.response?.data;
        const msgErro = String(
          dadosErro?.erro || dadosErro?.mensagem || "",
        ).toLowerCase();

        if (
          msgErro.includes("nenhum registro") ||
          msgErro.includes("não encontrado") ||
          status === 404
        ) {
          break;
        }

        console.error(
          `❌ Erro real em ${tipoNotificacao}:`,
          dadosErro || erro.message,
        );
        break;
      }
    }

    if (todos.length > 0) {
      return todos.map((boleto) => ({
        nome: boleto.IndividuosNome || boleto.Nome || "Associado",
        telefone: normalizarTelefoneBR(
          boleto.IndividuosContatosDdd &&
            (boleto.IndividuosContatosContato ||
              boleto.IndividuosContatosTelefone)
            ? `55${boleto.IndividuosContatosDdd}${
                boleto.IndividuosContatosContato ||
                boleto.IndividuosContatosTelefone
              }`
            : boleto.IndividuosContatosContato ||
                boleto.IndividuosContatosTelefone ||
                boleto.Telefone ||
                "",
        ),
        placa: boleto.VendasPlaca || boleto.Placa || "ND",
        vencimento:
          boleto.FaturasDataOriginal ||
          boleto.FaturasDataVencimento ||
          boleto.DataVencimento ||
          dataAlvo,
        valor: boleto.FaturasValor || boleto.Valor || "ND",
        url: boleto.UrlBoleto || "ND",
        linhadigitavel:
          boleto.FaturasLinhaDigitavel ||
          boleto.Faturasemv ||
          boleto.linhadigitavel ||
          "ND",
        tipo: tipoNotificacao,
        sistema: "south",
      }));
    }
  }

  return [];
}

async function southSegundaViaBoletos({ placa, documento }) {
  try {
    let placaFinal = normalizarPlaca(placa);
    let docFinal = normalizarDocumento(documento);
    const busca = placaFinal || docFinal;

    if (busca) {
      const associado = await southBuscarAssociado(busca);
      const docAssociado = associado?.Dados?.ClientesIndividuosDocumento;
      const placaAssociado =
        associado?.Dados?.VendasCarrosPlaca ||
        associado?.Dados?.CarrosPlaca ||
        associado?.Dados?.VendasCarrosPlacaImplemento;

      if (!docFinal && docAssociado)
        docFinal = normalizarDocumento(docAssociado);
      if (!placaFinal && placaAssociado)
        placaFinal = normalizarPlaca(placaAssociado);
    }

    if (!placaFinal || !docFinal) {
      return {
        status: "erro",
        mensagem: "Não foi possível localizar placa e documento",
        veiculos: [],
        mensagemWhatsapp:
          "❌ Não foi possível localizar os dados do associado.",
      };
    }

    const resposta = await axios.post(
      `${SOUTH_BASE_URL}Boletos/SegundaVia`,
      { Placa: placaFinal, Documento: docFinal },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: SOUTH_TOKEN,
        },
        timeout: 15000,
      },
    );

    const data = resposta.data;
    if (!data || !data.UrlBoleto) {
      return {
        status: "erro",
        mensagem: "Nenhum boleto encontrado na South",
        veiculos: [],
        mensagemWhatsapp: montarMensagemSemResultado(placaFinal || docFinal),
      };
    }

    const veiculo = {
      matricula: data.FaturasId || "ND",
      placa: data.VendasPlaca || placaFinal,
      vencimento:
        data.FaturasDataOriginal || data.FaturasDataVencimento || "ND",
      valor: data.FaturasValor || data.FaturasValorReal || "ND",
      url: data.UrlBoleto || "ND",
      linhadigitavel:
        data.FaturasLinhaDigitavel ||
        data.Faturasemv ||
        data.linhadigitavel ||
        data.LinhaDigitavel ||
        data.linhaDigitavel ||
        data.CodigoPix ||
        data.codigoPix ||
        data.PixCopiaCola ||
        data.pixCopiaCola ||
        "ND",
      nome: data.IndividuosNome || "ND",
      documento: data.IndividuosDocumento || docFinal,
      telefone: normalizarTelefoneBR(
        data.IndividuosContatosDdd && data.IndividuosContatosContato
          ? `55${data.IndividuosContatosDdd}${data.IndividuosContatosContato}`
          : "",
      ),
    };

    return {
      status: "sucesso",
      mensagem: "Boleto encontrado na South",
      veiculos: [veiculo],
      mensagemWhatsapp: montarMensagemBoleto(veiculo),
    };
  } catch (erro) {
    console.log("ERRO SOUTH:", erro.response?.data || erro.message);
    return {
      status: "erro",
      mensagem: "Erro ao consultar boleto na South",
      veiculos: [],
      mensagemWhatsapp:
        "❌ Não foi possível consultar o boleto. Tente novamente.",
    };
  }
}

// =============================================================================
// ROTA /clienteTelefone
// =============================================================================
app.post("/clienteTelefone", protegerRotaInterna, async (req, res) => {
  const telefone = normalizarTelefoneBR(req.body?.telefone || "");
  return res.json({ erro: false, nome: "Associado", telefone, veiculos: [] });
});

// =============================================================================
// ROTA /boleto
// =============================================================================
app.post("/boleto", protegerRotaInterna, async (req, res) => {
  try {
    const { sistema, tipo, cpf, cnpj, placa, documento } = req.body;
    const telefoneLog = normalizarTelefoneBR(req.body?.telefone || "");

    const placaFinal = normalizarPlaca(placa);
    const docFinal = normalizarDocumento(documento || cpf || cnpj || "");
    const entradaExibicao = placaFinal || docFinal;

    if (!placaFinal && !docFinal) {
      return res.status(400).json({
        status: "erro",
        mensagem: "Informe ao menos placa, cpf, cnpj ou documento",
        veiculos: [],
        mensagemWhatsapp:
          "❌ Informe os dados necessários para consultar o boleto.",
      });
    }

    const cpfFinal = normalizarDocumento(cpf || documento || "");
    const cnpjFinal = normalizarDocumento(cnpj || "");

    if (sistema === "i9") {
      const dadosI9 = await consultarBoletoI9({
        tipo,
        cpf: cpfFinal,
        cnpj: cnpjFinal,
        placa: placaFinal,
      });
      const resultadoI9 = adaptarResultadoI9(dadosI9);

      if (temResultadoI9(resultadoI9)) {
        adicionarLog(ARQUIVO_LOG_CONSULTAS, {
          telefone: telefoneLog,
          entrada: entradaExibicao,
          sistema: "i9",
          status: "encontrado",
        });

        return res.json({ sistema: "i9", ...resultadoI9 });
      }
      adicionarLog(ARQUIVO_LOG_CONSULTAS, {
        telefone: telefoneLog,
        entrada: entradaExibicao,
        sistema: "i9",
        status: "nao_encontrado",
      });
      return res.status(404).json({
        sistema: "i9",
        status: "erro",
        mensagem: resultadoI9.mensagem || "Nenhum boleto encontrado no I9",
        veiculos: [],
        mensagemWhatsapp:
          resultadoI9.mensagemWhatsapp ||
          montarMensagemSemResultado(entradaExibicao),
      });
    }

    if (sistema === "south") {
      const dadosSouth = await southSegundaViaBoletos({
        placa: placaFinal,
        documento: docFinal,
      });

      if (temResultadoSouth(dadosSouth)) {
        adicionarLog(ARQUIVO_LOG_CONSULTAS, {
          telefone: telefoneLog,
          entrada: entradaExibicao,
          sistema: "south",
          status: "encontrado",
        });

        return res.json({ sistema: "south", ...dadosSouth });
      }
      adicionarLog(ARQUIVO_LOG_CONSULTAS, {
        telefone: telefoneLog,
        entrada: entradaExibicao,
        sistema: "south",
        status: "nao_encontrado",
      });
      return res.status(404).json({
        sistema: "south",
        ...dadosSouth,
        mensagemWhatsapp:
          dadosSouth.mensagemWhatsapp ||
          montarMensagemSemResultado(entradaExibicao),
      });
    }

    // Tenta I9 primeiro, depois fallback para South
    try {
      const dadosI9 = await consultarBoletoI9({
        tipo,
        cpf: cpfFinal,
        cnpj: cnpjFinal,
        placa: placaFinal,
      });
      const resultadoI9 = adaptarResultadoI9(dadosI9);
      if (temResultadoI9(resultadoI9)) {
        adicionarLog(ARQUIVO_LOG_CONSULTAS, {
          telefone: telefoneLog,
          entrada: entradaExibicao,
          sistema: "i9",
          status: "encontrado",
        });

        return res.json({ sistema: "i9", ...resultadoI9 });
      }
    } catch (erroI9) {
      console.warn("I9 falhou:", extrairErro(erroI9));
    }

    const dadosSouth = await southSegundaViaBoletos({
      placa: placaFinal,
      documento: docFinal,
    });

    if (temResultadoSouth(dadosSouth)) {
      adicionarLog(ARQUIVO_LOG_CONSULTAS, {
        telefone: telefoneLog,
        entrada: entradaExibicao,
        sistema: "south",
        status: "encontrado",
      });

      return res.json({ sistema: "south", ...dadosSouth });
    }

    adicionarLog(ARQUIVO_LOG_CONSULTAS, {
      telefone: telefoneLog,
      entrada: entradaExibicao,
      sistema: "auto",
      status: "nao_encontrado",
    });

    return res.status(404).json({
      status: "erro",
      mensagem: "Nenhum boleto encontrado",
      veiculos: [],
      mensagemWhatsapp: montarMensagemSemResultado(entradaExibicao),
    });
  } catch (erro) {
    console.error("Erro /boleto:", extrairErro(erro));
    return res.status(500).json({
      status: "erro",
      mensagem: "Erro ao consultar boleto",
      veiculos: [],
      mensagemWhatsapp: "❌ Erro interno. Tente novamente.",
    });
  }
});
// =============================================================================
// ROTA /notificacoes-pendentes  (South + I9)
// Fluxo:
// - Lembrete 5 dias antes
// - Lembrete 2 dias antes
// - Cobrança 4 dias depois
// - Cobrança 15 dias depois
// - Parabéns no dia
// =============================================================================
app.get("/notificacoes-pendentes", protegerRotaInterna, async (req, res) => {
  const hoje = dayjs();

  const d5 = hoje.add(5, "day").format("YYYY-MM-DD");
  const d2 = hoje.add(2, "day").format("YYYY-MM-DD");
  const atraso4 = hoje.subtract(4, "day").format("YYYY-MM-DD");
  const atraso15 = hoje.subtract(15, "day").format("YYYY-MM-DD");

  try {
    const [
      niver,

      southList5,
      southList2,
      southListAtraso4,
      southListAtraso15,

      i9List5,
      i9List2,
      i9ListAtraso4,
      i9ListAtraso15,
    ] = await Promise.all([
      southBuscarAniversariantes(),

      // South
      southBuscarVencimentos(d5, "lembrete_5"),
      southBuscarVencimentos(d2, "lembrete_2"),
      southBuscarVencimentos(atraso4, "cobranca_4"),
      southBuscarVencimentos(atraso15, "cobranca_15"),

      // I9
      i9BuscarVencimentos(d5, "lembrete_5"),
      i9BuscarVencimentos(d2, "lembrete_2"),
      i9BuscarVencimentos(atraso4, "cobranca_4"),
      i9BuscarVencimentos(atraso15, "cobranca_15"),
    ]);

    const todas = [
      ...niver,

      ...southList5,
      ...southList2,
      ...southListAtraso4,
      ...southListAtraso15,

      ...i9List5,
      ...i9List2,
      ...i9ListAtraso4,
      ...i9ListAtraso15,
    ];

    const validas = todas.filter((item) => item.telefone);
    const unicas = [];
    const chaves = new Set();

    for (const item of validas) {
      const chave = `${item.tipo}-${item.telefone}-${item.placa || ""}-${item.vencimento || ""}`;

      if (!chaves.has(chave)) {
        chaves.add(chave);
        unicas.push(item);
      }
    }

    return res.json({
      total: unicas.length,
      datas: {
        hoje: hoje.format("YYYY-MM-DD"),
        lembrete_5: d5,
        lembrete_2: d2,
        cobranca_4: atraso4,
        cobranca_15: atraso15,
      },
      resumo: {
        aniversarios: niver.length,
        south: {
          lembrete_5: southList5.length,
          lembrete_2: southList2.length,
          cobranca_4: southListAtraso4.length,
          cobranca_15: southListAtraso15.length,
        },
        i9: {
          lembrete_5: i9List5.length,
          lembrete_2: i9List2.length,
          cobranca_4: i9ListAtraso4.length,
          cobranca_15: i9ListAtraso15.length,
        },
      },
      notificacoes: unicas,
    });
  } catch (erro) {
    console.error("Erro em /notificacoes-pendentes:", erro.message);

    return res.status(500).json({
      erro: "Erro ao consolidar notificações diárias",
    });
  }
});

// =============================================================================
// ROTAS DE DIAGNÓSTICO
// =============================================================================
app.get("/teste-aniversariantes", protegerRotaInterna, async (req, res) => {
  const dados = await southBuscarAniversariantes();
  res.json({ total: dados.length, dados });
});

app.get("/teste-vencimentos", protegerRotaInterna, async (req, res) => {
  const data = req.query.data || dayjs().format("YYYY-MM-DD");
  const tipo = req.query.tipo || "manual";
  const dados = await southBuscarVencimentos(data, tipo);
  res.json({ total: dados.length, data, sistema: "south", dados });
});

app.get("/teste-vencimentos-i9", protegerRotaInterna, async (req, res) => {
  const data = req.query.data || dayjs().format("YYYY-MM-DD");
  const tipo = req.query.tipo || "manual";
  const dados = await i9BuscarVencimentos(data, tipo);
  res.json({ total: dados.length, data, sistema: "i9", dados });
});
app.post("/teste-template", protegerRotaInterna, async (req, res) => {
  try {
    const { telefone, template, parametros = [] } = req.body;

    if (!telefone || !template) {
      return res.status(400).json({
        ok: false,
        erro: "Informe telefone e template",
      });
    }

    const numero = normalizarTelefoneBR(telefone);
    const resultado = await enviarTemplate(numero, template, parametros);

    return res.json({
      ok: true,
      telefone: numero,
      template,
      resultado,
    });
  } catch (erro) {
    return res.status(500).json({
      ok: false,
      erro: erro.response?.data || erro.message,
    });
  }
});
app.get("/dashboard/resumo", protegerRotaInterna, (req, res) => {
  const consultas = carregarJson(ARQUIVO_LOG_CONSULTAS, []);
  const notificacoes = carregarJson(ARQUIVO_LOG_NOTIFICACOES, []);
  const optout = carregarJson(ARQUIVO_OPTOUT, []);
  const envios = carregarJson(ARQUIVO_ENVIOS, {
    porDia: {},
    porHora: {},
    enviosExatos: {},
  });
  const avaliacoes = carregarJson(ARQUIVO_LOG_AVALIACOES, []);

  const hoje = dayjs().format("YYYY-MM-DD");

  const consultasHoje = consultas.filter((c) =>
    String(c.data || "").startsWith(hoje)
  );

  const notificacoesHoje = notificacoes.filter((n) =>
    String(n.data || "").startsWith(hoje)
  );

  const avaliacoesHoje = avaliacoes.filter((a) =>
    String(a.data || "").startsWith(hoje)
  );

  const mediaAvaliacoes =
    avaliacoes.length > 0
      ? avaliacoes.reduce((soma, a) => soma + Number(a.nota || 0), 0) /
        avaliacoes.length
      : 0;

  const mediaAvaliacoesHoje =
    avaliacoesHoje.length > 0
      ? avaliacoesHoje.reduce((soma, a) => soma + Number(a.nota || 0), 0) /
        avaliacoesHoje.length
      : 0;

  res.json({
    consultasHoje: consultasHoje.length,
    boletosEncontradosHoje: consultasHoje.filter(
      (c) => c.status === "encontrado"
    ).length,
    notificacoesHoje: notificacoesHoje.length,
    optoutTotal: Array.isArray(optout) ? optout.length : 0,
    enviosRegistrados: Object.keys(envios.enviosExatos || {}).length,

    avaliacoesHoje: avaliacoesHoje.length,
    mediaAvaliacoes: Number(mediaAvaliacoes.toFixed(2)),
    mediaAvaliacoesHoje: Number(mediaAvaliacoesHoje.toFixed(2)),
  });
});

app.get("/dashboard/consultas", protegerRotaInterna, (req, res) => {
  res.json(carregarJson(ARQUIVO_LOG_CONSULTAS, []).slice(0, 100));
});

app.get("/dashboard/notificacoes", protegerRotaInterna, (req, res) => {
  res.json(carregarJson(ARQUIVO_LOG_NOTIFICACOES, []).slice(0, 100));
});

app.get("/dashboard/optout", protegerRotaInterna, (req, res) => {
  res.json(carregarJson(ARQUIVO_OPTOUT, []));
});
app.get("/dashboard/avaliacoes", protegerRotaInterna, (req, res) => {
  res.json(carregarJson(ARQUIVO_LOG_AVALIACOES, []).slice(0, 100));
});
app.listen(PORT, () => {
  console.log(`✅ API rodando na porta ${PORT}`);
});

async function enviarTemplate(to, templateName, parametros = []) {
  try {
    const components = [];

    if (parametros.length > 0) {
      components.push({
        type: "body",
        parameters: parametros.map((p) => ({
          type: "text",
          text: String(p || ""),
        })),
      });
    }

    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: "pt_BR" },
          components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log(
      `✅ TEMPLATE ENVIADO (${templateName}) para ${to}:`,
      JSON.stringify(response.data, null, 2),
    );
    return response.data;
  } catch (erro) {
    console.error("❌ ERRO TEMPLATE:", erro.response?.data || erro.message);
  }
}
module.exports = {
  app,
  enviarTexto,
  enviarImagem,
  enviarTemplate,
  normalizarTelefoneBR,
  registrarLogNotificacao,
};

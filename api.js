require("dotenv").config();

const express = require("express");
const axios = require("axios");
const dayjs = require("dayjs");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);

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

  // Se o número veio sem o 55, adiciona
  if (!digitos.startsWith("55")) {
    digitos = `55${digitos}`;
  }

  // LÓGICA DO NONO DÍGITO (Para DDDs >= 31 como o seu 75)
  // Se tem 55 + DDD (2 dígitos) + 8 dígitos = 12 dígitos total
  // Precisamos inserir o "9" após o DDD
  if (digitos.length === 12) {
    const parte1 = digitos.slice(0, 4); // 5575
    const parte2 = digitos.slice(4);    // 81080660
    digitos = `${parte1}9${parte2}`;    // 5575981080660
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
// WEBHOOK — recebimento de mensagens (POST)
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

// =============================================================================
// ENVIO DE MENSAGEM
// =============================================================================
const API_VERSION = process.env.WA_API_VERSION || "v25.0";

async function enviarTexto(to, texto) {
  try {
    console.log(`--- TENTANDO ENVIAR TEXTO ---`);
    console.log(`Para: ${to}`);
    console.log(`Versão API: v25.0`);

    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to, // O número que o bot recebeu
        type: "text",
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    console.log(`✅ SUCESSO META:`, response.data);
  } catch (erro) {
    console.error(`❌ ERRO DETALHADO DA META:`, erro.response?.data || erro.message);
  }
}

async function enviarImagem(to, imageUrl, caption = "") {
  try {
    console.log(`--- TENTANDO ENVIAR IMAGEM ---`);
    console.log(`Para: ${to}`);
    console.log(`URL da Imagem: ${imageUrl}`);

    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "image",
        image: { link: imageUrl, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    console.log(`✅ IMAGEM ENVIADA:`, response.data);
  } catch (erro) {
    console.error(`❌ ERRO IMAGEM META:`, erro.response?.data || erro.message);
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
  const linhaDigitavel =
    veiculo.linhadigitavel && veiculo.linhadigitavel !== "ND"
      ? String(veiculo.linhadigitavel).replace(/\s+/g, "")
      : "";

  let msg = `💳 *Boleto encontrado com sucesso!*\n\n`;
  msg += `👤 *Associado:* ${nome}\n`;
  msg += `🚗 *Placa:* ${placa}\n`;
  msg += `📅 *Vencimento:* ${vencimento}\n`;
  msg += `💰 *Valor:* ${valor}\n`;

  if (linhaDigitavel) {
    msg += `📄 *Linha digitável:*\n${linhaDigitavel}\n`;
  }

  if (url && url !== "ND") {
    msg += `\n🔗 *Acessar boleto:*\n${url}`;
  }

  return msg;
}

function montarMensagemSemResultado(entrada) {
  return `❌ *Nenhum boleto encontrado* para *${entrada || "informado"}*.\n\nConfira os dados e tente novamente.`;
}

// =============================================================================
// I9
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
    valor:
      v?.valor || v?.Valor || v?.valor_boleto || v?.ValorBoleto || "ND",
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
  if (!Array.isArray(dados?.veiculos) || dados.veiculos.length === 0) return false;

  return dados.veiculos.some(
    (v) =>
      (v.url && v.url !== "ND") ||
      (v.linhadigitavel && v.linhadigitavel !== "ND") ||
      (v.vencimento && v.vencimento !== "ND") ||
      (v.valor && v.valor !== "ND")
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
      (v.valor && v.valor !== "ND")
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
    mensagem: dadosI9?.mensagem || "Cadastro encontrado no I9, mas sem boleto disponível",
    veiculos: [],
    mensagemWhatsapp: "❌ Cadastro encontrado, mas não há boleto disponível no momento.",
  };
}

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
        headers: {
          Accept: "application/json",
          Authorization: SOUTH_TOKEN,
        },
        timeout: 15000,
      }
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
    const resposta = await axios.get(`${SOUTH_BASE_URL}Clientes/aniversariantes`, {
      params: { Mes: mes, Dia: dia },
      headers: {
        Authorization: SOUTH_TOKEN,
        Accept: "application/json",
      },
      timeout: 15000,
    });

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
          : cli.IndividuosContatosTelefone || ""
      ),
      tipo: "aniversario",
      dataNascimento: cli.IndividuosDataNascimento || "",
    }));
  } catch (erro) {
    console.error("❌ Erro Aniversariantes:", erro.response?.status, erro.response?.data || erro.message);
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
        const resposta = await axios.post(`${SOUTH_BASE_URL}Boletos/lista`, payload, {
          headers: {
            Authorization: SOUTH_TOKEN,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          timeout: 15000,
        });

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
        const msgErro = String(dadosErro?.erro || dadosErro?.mensagem || "").toLowerCase();

        if (
          msgErro.includes("nenhum registro") ||
          msgErro.includes("não encontrado") ||
          status === 404
        ) {
          break;
        }

        console.error(`❌ Erro real em ${tipoNotificacao}:`, dadosErro || erro.message);
        break;
      }
    }

    if (todos.length > 0) {
      return todos.map((boleto) => ({
        nome: boleto.IndividuosNome || boleto.Nome || "Associado",
        telefone: normalizarTelefoneBR(
          boleto.IndividuosContatosDdd &&
            (boleto.IndividuosContatosContato || boleto.IndividuosContatosTelefone)
            ? `55${boleto.IndividuosContatosDdd}${
                boleto.IndividuosContatosContato || boleto.IndividuosContatosTelefone
              }`
            : boleto.IndividuosContatosContato ||
              boleto.IndividuosContatosTelefone ||
              boleto.Telefone ||
              ""
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

      if (!docFinal && docAssociado) docFinal = normalizarDocumento(docAssociado);
      if (!placaFinal && placaAssociado) placaFinal = normalizarPlaca(placaAssociado);
    }

    if (!placaFinal || !docFinal) {
      return {
        status: "erro",
        mensagem: "Não foi possível localizar placa e documento",
        veiculos: [],
        mensagemWhatsapp: "❌ Não foi possível localizar os dados do associado.",
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
      }
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
      vencimento: data.FaturasDataOriginal || data.FaturasDataVencimento || "ND",
      valor: data.FaturasValor || data.FaturasValorReal || "ND",
      url: data.UrlBoleto || "ND",
      linhadigitavel: data.Faturasemv || "ND",
      nome: data.IndividuosNome || "ND",
      documento: data.IndividuosDocumento || docFinal,
      telefone: normalizarTelefoneBR(
        data.IndividuosContatosDdd && data.IndividuosContatosContato
          ? `55${data.IndividuosContatosDdd}${data.IndividuosContatosContato}`
          : ""
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
      mensagemWhatsapp: "❌ Não foi possível consultar o boleto. Tente novamente.",
    };
  }
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
// ROTA /clienteTelefone
// =============================================================================
app.post("/clienteTelefone", protegerRotaInterna, async (req, res) => {
  const telefone = normalizarTelefoneBR(req.body?.telefone || "");
  return res.json({
    erro: false,
    nome: "Associado",
    telefone,
    veiculos: [],
  });
});

// =============================================================================
// ROTA /boleto
// =============================================================================
app.post("/boleto", protegerRotaInterna, async (req, res) => {
  try {
    const { sistema, tipo, cpf, cnpj, placa, documento } = req.body;

    const placaFinal = normalizarPlaca(placa);
    const docFinal = normalizarDocumento(documento || cpf || cnpj || "");
    const entradaExibicao = placaFinal || docFinal;

    if (!placaFinal && !docFinal) {
      return res.status(400).json({
        status: "erro",
        mensagem: "Informe ao menos placa, cpf, cnpj ou documento",
        veiculos: [],
        mensagemWhatsapp: "❌ Informe os dados necessários para consultar o boleto.",
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
        return res.json({ sistema: "i9", ...resultadoI9 });
      }

      return res.status(404).json({
        sistema: "i9",
        status: "erro",
        mensagem: resultadoI9.mensagem || "Nenhum boleto encontrado no I9",
        veiculos: [],
        mensagemWhatsapp:
          resultadoI9.mensagemWhatsapp || montarMensagemSemResultado(entradaExibicao),
      });
    }

    if (sistema === "south") {
      const dadosSouth = await southSegundaViaBoletos({
        placa: placaFinal,
        documento: docFinal,
      });

      if (temResultadoSouth(dadosSouth)) {
        return res.json({ sistema: "south", ...dadosSouth });
      }

      return res.status(404).json({
        sistema: "south",
        ...dadosSouth,
        mensagemWhatsapp:
          dadosSouth.mensagemWhatsapp || montarMensagemSemResultado(entradaExibicao),
      });
    }

    try {
      const dadosI9 = await consultarBoletoI9({
        tipo,
        cpf: cpfFinal,
        cnpj: cnpjFinal,
        placa: placaFinal,
      });

      const resultadoI9 = adaptarResultadoI9(dadosI9);

      if (temResultadoI9(resultadoI9)) {
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
      return res.json({ sistema: "south", ...dadosSouth });
    }

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
// ROTA /notificacoes-pendentes
// =============================================================================
app.get("/notificacoes-pendentes", protegerRotaInterna, async (req, res) => {
  const hoje = dayjs();
  const d5 = hoje.add(5, "day").format("YYYY-MM-DD");
  const d2 = hoje.add(2, "day").format("YYYY-MM-DD");
  const d0 = hoje.format("YYYY-MM-DD");
  const atrasado = hoje.subtract(5, "day").format("YYYY-MM-DD");

  try {
    const [niver, list5, list2, listHoje, listAtraso] = await Promise.all([
      southBuscarAniversariantes(),
      southBuscarVencimentos(d5, "lembrete_5"),
      southBuscarVencimentos(d2, "lembrete_2"),
      southBuscarVencimentos(d0, "vencimento_hoje"),
      southBuscarVencimentos(atrasado, "cobranca_atraso"),
    ]);

    const todas = [...niver, ...list5, ...list2, ...listHoje, ...listAtraso];
    const validas = todas.filter((item) => item.telefone);

    const unicas = [];
    const chaves = new Set();

    for (const item of validas) {
      const chave = `${item.tipo}-${item.telefone}-${item.placa || ""}`;
      if (!chaves.has(chave)) {
        chaves.add(chave);
        unicas.push(item);
      }
    }

    return res.json({
      total: unicas.length,
      resumo: {
        aniversarios: niver.length,
        lembrete_5: list5.length,
        lembrete_2: list2.length,
        vencimento_hoje: listHoje.length,
        cobranca_atraso: listAtraso.length,
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
  res.json({ total: dados.length, data, dados });
});

app.listen(PORT, () => {
  console.log(`✅ API rodando na porta ${PORT}`);
});

module.exports = {
  app,
  enviarTexto,
  enviarImagem,
  normalizarTelefoneBR,
};
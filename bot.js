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
const DELAY_ENVIO_MS = 3000;

const IMAGEM_BOAS_VINDAS =
  process.env.IMAGEM_URL ||
  "https://raw.githubusercontent.com/VinnyLast/bot-avseg/refs/heads/main/imagem.jpg";

const TEST_MODE = process.env.TEST_MODE === "true";
const ENABLE_CRON = process.env.ENABLE_CRON === "true";
const ALLOWED_NUMBERS = new Set(
  String(process.env.ALLOWED_NUMBERS || "")
    .split(",")
    .map((n) => normalizarTelefoneBR(n))
    .filter(Boolean)
);

// Links que serão adicionados na segunda-feira — deixe vazio para ocultar o botão
const LINK_COTACAO = process.env.LINK_COTACAO || "";
const LINK_VISTORIA = process.env.LINK_VISTORIA || "";

// Informações da empresa
const INSTAGRAM = "https://www.instagram.com/avsegauto/";
const LOCALIZACAO = "https://maps.app.goo.gl/EauXSA7CtM3Lxa5D8";
const TELEFONE_ASSISTENCIA = "0800 130-0078";

// =============================================================================
// ESTADO EM MEMÓRIA
// =============================================================================
const estadoUsuario = {};   // null | "pagamento" | "avaliacao"
const modoHumano = new Set(); // Números que estão com atendente humano
const usuariosOptOut = new Set(); // Não recebem lembretes preventivos
const avaliacoes = [];      // Histórico de avaliações (em memória)

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

  const placaAntiga = /^[A-Z]{3}[0-9]{4}$/;
  const placaMercosul = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;
  return placaAntiga.test(valor) || placaMercosul.test(valor);
}

function normalizarPlaca(texto) {
  return String(texto || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatarValor(valor) {
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
      String(v.linhadigitavel).trim() !== ""
  );
}

function existeBoletoDisponivel(v) {
  return Boolean(
    (v?.url && v.url !== "ND") ||
      (v?.linhadigitavel && v.linhadigitavel !== "ND") ||
      (v?.valor && v.valor !== "ND") ||
      (v?.vencimento && v.vencimento !== "ND")
  );
}

function podeEnviar(numero) {
  const normalizado = normalizarTelefoneBR(numero);
  if (!normalizado) return false;
  if (!TEST_MODE) return true;
  return ALLOWED_NUMBERS.has(normalizado);
}

async function enviarTextoSeguro(to, texto) {
  const numero = normalizarTelefoneBR(to);
  if (!numero) {
    console.warn("⚠️ Número inválido para envio de texto");
    return;
  }
  if (!podeEnviar(numero)) {
    console.log(`🧪 TEST_MODE ativo: envio bloqueado para ${numero}`);
    return;
  }
  try {
    await enviarTexto(numero, texto);
    console.log(`✅ Texto enviado para ${numero}`);
  } catch (erro) {
    console.error(`❌ Erro ao enviar texto para ${numero}:`, erro.response?.data || erro.message);
  }
}

async function enviarImagemSegura(to, imageUrl, caption = "") {
  const numero = normalizarTelefoneBR(to);
  if (!numero) {
    console.warn("⚠️ Número inválido para envio de imagem");
    return;
  }
  if (!podeEnviar(numero)) {
    console.log(`🧪 TEST_MODE ativo: imagem bloqueada para ${numero}`);
    return;
  }
  try {
    await enviarImagem(numero, imageUrl, caption);
    console.log(`✅ Imagem enviada para ${numero}`);
  } catch (erro) {
    console.error(`❌ Erro ao enviar imagem para ${numero}:`, erro.response?.data || erro.message);
  }
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

// =============================================================================
// MONTAGEM DO MENU
// =============================================================================
function montarOpcoeMenu() {
  const opcoes = [];
  let num = 1;

  // Cotação (exibe link se configurado, senão avisa que em breve)
  opcoes.push(`${num++}️⃣ Cotação`);
  // Pagamentos sempre disponível
  opcoes.push(`${num++}️⃣ Pagamentos`);
  // Assistência 24h
  opcoes.push(`${num++}️⃣ Acione assistência 24h`);
  // Vistoria
  opcoes.push(`${num++}️⃣ Vistoria do veículo`);
  // Falar com atendente
  opcoes.push(`${num++}️⃣ Falar com atendente`);
  // Avaliar atendimento
  opcoes.push(`${num++}️⃣ Avaliar atendimento`);
  // Encerrar
  opcoes.push(`${num++}️⃣ Encerrar conversa`);

  return opcoes.join("\n");
}

async function enviarMenu(numero, cliente) {
  let saudacao = `🛡️ *AVSEG Proteção Veicular*\n\n`;

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
  saudacao += montarOpcoeMenu();
  saudacao += `\n\n`;
  saudacao += `──────────────────\n`;
  saudacao += `📸 *Instagram:* ${INSTAGRAM}\n`;
  saudacao += `📍 *Localização:* ${LOCALIZACAO}\n`;
  saudacao += `⭐ *Google:* 4,7 — 63 avaliações\n`;
  saudacao += `\n_(Para parar notificações automáticas, responda *0*)_`;

  await enviarImagemSegura(numero, IMAGEM_BOAS_VINDAS, saudacao);
}

// =============================================================================
// MENSAGENS DE BOLETO
// =============================================================================
function montarResumoVeiculo(v, indice) {
  let msg = `💳 *Boleto ${indice + 1} encontrado:*\n\n`;
  msg += `👤 Associado: ${v.nome || "ND"}\n`;
  msg += `📋 Matrícula: ${v.matricula || "ND"}\n`;
  msg += `🚗 Placa: ${v.placa || "ND"}\n`;
  msg += `📅 Vencimento: ${formatarDataBR(v.vencimento)}\n`;
  msg += `💰 Valor: ${formatarValor(v.valor)}\n`;
  if (v.url && v.url !== "ND") msg += `🔗 Boleto: ${v.url}\n`;
  return msg;
}

// =============================================================================
// MENSAGENS DE NOTIFICAÇÃO AUTOMÁTICA
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
        `Obrigado por confiar na nossa proteção! 🚗🛡️\n\n` +
        `📍 ${LOCALIZACAO}`
      );

    case "lembrete_5":
      return (
        `Olá ${nome}! 🚗\n\n` +
        `Passando para lembrar que o boleto da sua proteção${temPlaca ? ` da placa *${placa}*` : ""} vence em *5 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nSe precisar da 2ª via, basta responder com *menu*.\n` +
        `\n_(Para parar de receber lembretes, responda com *0*)_`
      );

    case "lembrete_2":
      return (
        `Atenção ${nome}! 🚨\n\n` +
        `Seu boleto${temPlaca ? ` da placa *${placa}*` : ""} vence em *2 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nJá está com ele em mãos? Responda *menu* para obter a 2ª via.\n` +
        `\n_(Para parar de receber lembretes, responda com *0*)_`
      );

    case "vencimento_hoje":
      return (
        `🚨 *Vence hoje!*\n\n` +
        `${nome}, o seu boleto${temPlaca ? ` da placa *${placa}*` : ""} vence *hoje*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nEvite ficar sem cobertura. Se precisar da 2ª via, responda com *menu*.`
      );

    case "cobranca_atraso":
      return (
        `⚠️ *Aviso de pendência*\n\n` +
        `${nome}, identificamos que o boleto${temPlaca ? ` da placa *${placa}*` : ""} venceu há *2 dias*.\n` +
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
async function iniciarAvaliacao(from) {
  estadoUsuario[from] = "avaliacao";
  await enviarTextoSeguro(
    from,
    `⭐ *Avalie nosso atendimento!*\n\n` +
      `Responda com um número de *1 a 5*:\n\n` +
      `1️⃣ — Ruim\n` +
      `2️⃣ — Regular\n` +
      `3️⃣ — Bom\n` +
      `4️⃣ — Ótimo\n` +
      `5️⃣ — Excelente 😍`
  );
}

async function processarAvaliacao(from, texto) {
  const nota = parseInt(texto, 10);

  if (isNaN(nota) || nota < 1 || nota > 5) {
    await enviarTextoSeguro(
      from,
      `❌ Nota inválida. Por favor, responda com um número de *1 a 5*.`
    );
    return;
  }

  const estrelas = "⭐".repeat(nota);
  const registros = { telefone: from, nota, data: new Date().toISOString() };
  avaliacoes.push(registros);

  console.log(`📊 Avaliação registrada: ${from} — nota ${nota}/5`);

  const mensagemNota = {
    1: `Lamentamos pela experiência. Vamos trabalhar para melhorar! 🙏`,
    2: `Obrigado pelo feedback. Estamos empenhados em melhorar! 💪`,
    3: `Boa! Queremos sempre evoluir. Obrigado pela avaliação! 😊`,
    4: `Ótimo! Fico feliz que tenha gostado do atendimento! 🤩`,
    5: `Incrível! Sua satisfação é tudo para nós! 🥰🚗🛡️`,
  };

  estadoUsuario[from] = null;
  await enviarTextoSeguro(
    from,
    `${estrelas}\n\n*Nota ${nota}/5* — ${mensagemNota[nota]}\n\nSe precisar de algo mais, estamos à disposição. Digite *menu* a qualquer momento.`
  );
}

// =============================================================================
// FLUXO DE PAGAMENTO (2ª via de boleto)
// =============================================================================
async function processarPagamento(from, bodyText) {
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
    await enviarTextoSeguro(from, "❌ Envie uma placa, CPF (11 dígitos) ou CNPJ (14 dígitos) válido.");
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
        await enviarTextoSeguro(from, "❌ Não consegui consultar seu boleto agora. Tente novamente em instantes.");
        estadoUsuario[from] = null;
        return;
      }
    }

    if (dados?.status === "sucesso" && dados?.mensagemWhatsapp) {
      await enviarTextoSeguro(from, dados.mensagemWhatsapp);

      const veiculosComLinha = Array.isArray(dados.veiculos)
        ? dados.veiculos.filter(existeLinhaDigitavel)
        : [];

      for (const v of veiculosComLinha) {
        await delay(500);
        await enviarTextoSeguro(from, String(v.linhadigitavel).replace(/\s+/g, ""));
      }

      await delay(500);
      await enviarTextoSeguro(from, "Digite *menu* para voltar ao início ou *5* para encerrar.");
      estadoUsuario[from] = null;
      return;
    }

    if (dados?.status === "erro" && dados?.mensagemWhatsapp) {
      await enviarTextoSeguro(from, dados.mensagemWhatsapp);
      await delay(500);
      await enviarTextoSeguro(from, "Digite *menu* para voltar ao início.");
      estadoUsuario[from] = null;
      return;
    }

    if (!dados || !Array.isArray(dados.veiculos) || dados.veiculos.length === 0) {
      await enviarTextoSeguro(from, `❌ ${dados?.mensagem || "Nenhum registro encontrado."}`);
      estadoUsuario[from] = null;
      return;
    }

    const comBoleto = dados.veiculos.filter(existeBoletoDisponivel);

    if (comBoleto.length === 0) {
      await enviarTextoSeguro(from, `⚠️ ${dados?.mensagem || "Cadastro encontrado, mas não há boleto em aberto no momento."}`);
      estadoUsuario[from] = null;
      return;
    }

    for (let i = 0; i < comBoleto.length; i++) {
      const v = comBoleto[i];
      await enviarTextoSeguro(from, montarResumoVeiculo(v, i));

      if (existeLinhaDigitavel(v)) {
        await delay(500);
        await enviarTextoSeguro(from, String(v.linhadigitavel).replace(/\s+/g, ""));
      }

      await delay(DELAY_ENVIO_MS);
    }

    await enviarTextoSeguro(from, "Digite *menu* para voltar ao início ou *5* para encerrar.");
    estadoUsuario[from] = null;
  } catch (erro) {
    console.error("Erro no fluxo de pagamento:", erro.message);
    await enviarTextoSeguro(from, "❌ Não consegui consultar seu boleto agora. Tente novamente em instantes.");
    estadoUsuario[from] = null;
  }
}

// =============================================================================
// PROCESSAMENTO DE MENSAGENS
// =============================================================================
app.on("wa_message", async ({ from, bodyText }) => {
  const texto = String(bodyText || "").toLowerCase().trim();
  const http = axiosInterno();

  // ── 0. Se está em modo humano, o atendente responde pelo Meta Business Suite.
  //       Bot só reage se o cliente pedir para voltar ao bot.
  if (modoHumano.has(from)) {
    if (["menu", "bot", "oi", "olá", "ola"].includes(texto)) {
      modoHumano.delete(from);
      estadoUsuario[from] = null;
      let cliente = null;
      try {
        const resposta = await http.post("/clienteTelefone", { telefone: from });
        cliente = resposta.data;
      } catch (_) {}
      await enviarMenu(from, cliente);
    }
    // Qualquer outra mensagem: bot silencioso, humano atende pelo Inbox da Meta
    return;
  }

  // ── 1. Se está em fluxo de avaliação
  if (estadoUsuario[from] === "avaliacao") {
    await processarAvaliacao(from, texto);
    return;
  }

  // ── 2. Opt-out / opt-in de notificações
  if (texto === "0" || texto === "parar") {
    usuariosOptOut.add(from);
    estadoUsuario[from] = null;
    await enviarTextoSeguro(
      from,
      `✅ *Notificações preventivas desativadas.*\n\nVocê não receberá mais os lembretes de 5 e 2 dias antes do vencimento.\n\nSe quiser voltar a receber, digite *voltar*.`
    );
    return;
  }

  if (texto === "voltar") {
    usuariosOptOut.delete(from);
    estadoUsuario[from] = null;
    await enviarTextoSeguro(
      from,
      `✅ *Notificações ativadas novamente!*\n\nVocê voltará a receber nossos lembretes preventivos. Obrigado!`
    );
    return;
  }

  // ── 3. Abertura de menu
  if (["oi", "olá", "ola", "menu", "inicio", "início"].includes(texto)) {
    estadoUsuario[from] = null;
    let cliente = null;
    try {
      const resposta = await http.post("/clienteTelefone", { telefone: from });
      cliente = resposta.data;
    } catch (_) {}
    await enviarMenu(from, cliente);
    return;
  }

  // ── 4. Se uma placa foi enviada diretamente, já vai para pagamento
  if (parecePlaca(bodyText)) {
    estadoUsuario[from] = "pagamento";
  }

  // ── 5. Opções do menu ────────────────────────────────────────────────────────

  // 1 — Cotação
  if (texto === "1") {
    if (LINK_COTACAO) {
      await enviarTextoSeguro(from, `📋 *Cotação*\n\nAcesse o link abaixo e faça sua cotação:\n\n🔗 ${LINK_COTACAO}`);
    } else {
      await enviarTextoSeguro(
        from,
        `📋 *Cotação*\n\nNosso sistema de cotação online estará disponível em breve! 🚀\n\nPor enquanto, nosso time pode te ajudar. Digite *5️⃣* para falar com um atendente.`
      );
    }
    return;
  }

  // 2 — Pagamentos
  if (texto === "2") {
    estadoUsuario[from] = "pagamento";
    await enviarTextoSeguro(
      from,
      `💳 *Pagamentos — 2ª via de boleto*\n\nEnvie um dos dados abaixo:\n\n• 📋 CPF do titular\n• 🏢 CNPJ\n• 🚗 Placa do veículo`
    );
    return;
  }

  // 3 — Acione assistência 24h
  if (texto === "3") {
    await enviarTextoSeguro(
      from,
      `🚨 *Assistência 24 horas*\n\nPara acionar a assistência, entre em contato com nossa central:\n\n📞 *${TELEFONE_ASSISTENCIA}*\n\nNossa equipe irá te orientar imediatamente, a qualquer hora do dia ou da noite. Estamos com você! 🤝\n\n📍 ${LOCALIZACAO}`
    );
    return;
  }

  // 4 — Vistoria do veículo
  if (texto === "4") {
    if (LINK_VISTORIA) {
      await enviarTextoSeguro(from, `🔍 *Vistoria do Veículo*\n\nAgende sua vistoria pelo link:\n\n🔗 ${LINK_VISTORIA}`);
    } else {
      await enviarTextoSeguro(
        from,
        `🔍 *Vistoria do Veículo*\n\nO agendamento online de vistoria estará disponível em breve! 🚀\n\nPor enquanto, fale com nosso time. Digite *5️⃣* para ser atendido por um especialista.`
      );
    }
    return;
  }

  // 5 — Falar com atendente (PRIORIDADE — handover para Meta Business Suite)
  if (texto === "5") {
    modoHumano.add(from);
    estadoUsuario[from] = null;
    await enviarTextoSeguro(
      from,
      `👨‍💻 *Atendimento Humano*\n\n` +
        `Você será atendido por um de nossos especialistas agora mesmo! ✅\n\n` +
        `Nossa equipe irá responder em instantes por este mesmo WhatsApp.\n\n` +
        `_Se quiser voltar ao menu automático a qualquer momento, basta digitar *menu*._`
    );
    console.log(`👤 Atendimento humano ativado para ${from}`);
    return;
  }

  // 6 — Avaliar atendimento
  if (texto === "6") {
    await iniciarAvaliacao(from);
    return;
  }

  // 7 — Encerrar conversa
  if (["7", "encerrar", "finalizar", "sair"].includes(texto)) {
    estadoUsuario[from] = null;
    modoHumano.delete(from);
    await enviarTextoSeguro(
      from,
      `✅ *Conversa encerrada.*\n\nFoi um prazer te atender! 😊\n\nQuando precisar, é só enviar *oi* ou *menu*. Estaremos aqui!\n\n🛡️ *AVSEG Proteção Veicular*`
    );
    return;
  }

  // ── 6. Fluxo de pagamento (estado ativo ou placa enviada diretamente)
  if (estadoUsuario[from] === "pagamento") {
    await processarPagamento(from, bodyText);
    return;
  }

  // ── 7. Mensagem não reconhecida
  await enviarTextoSeguro(
    from,
    `Não entendi sua mensagem. 😅\n\nDigite *menu* para ver todas as opções disponíveis.`
  );
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

        // Não envia lembretes preventivos para quem fez opt-out
        if (
          usuariosOptOut.has(telefone) &&
          (item.tipo === "lembrete_5" || item.tipo === "lembrete_2")
        ) {
          console.log(`⏭️ Opt-out: ${telefone} ignorado (${item.tipo})`);
          continue;
        }

        // Não interrompe atendimento humano ativo com notificações automáticas
        if (modoHumano.has(telefone)) {
          console.log(`⏭️ Modo humano: ${telefone} ignorado (${item.tipo})`);
          continue;
        }

        const mensagem = montarMensagemNotificacao(item);
        if (!mensagem) continue;

        await enviarTextoSeguro(telefone, mensagem);

        // Se tem boleto disponível, envia o link junto na notificação
        if (item.url && item.url !== "ND" && item.tipo !== "aniversario") {
          await delay(500);
          await enviarTextoSeguro(telefone, `🔗 *Acesse seu boleto:*\n${item.url}`);
        }

        await delay(DELAY_ENVIO_MS);
      }

      console.log("✅ Rotina de notificações concluída.");
    } catch (erro) {
      console.error("❌ Erro na rotina de notificações:", erro.response?.data || erro.message);
    }
  });

  console.log("⏰ CRON habilitado — notificações diárias às 09:00.");
} else {
  console.log("🧪 CRON desabilitado (ENABLE_CRON != true).");
}

// =============================================================================
// ROTA DE DIAGNÓSTICO — avaliacoes
// =============================================================================
const { protegerRotaInterna } = (() => {
  const INTERNAL_API_KEY_LOCAL = process.env.INTERNAL_API_KEY;
  return {
    protegerRotaInterna: (req, res, next) => {
      const chave = req.headers["x-api-key"];
      if (!INTERNAL_API_KEY_LOCAL || chave !== INTERNAL_API_KEY_LOCAL) {
        return res.status(401).json({ status: "erro", mensagem: "Não autorizado" });
      }
      next();
    },
  };
})();

app.get("/avaliacoes", protegerRotaInterna, (req, res) => {
  const media =
    avaliacoes.length > 0
      ? (avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length).toFixed(2)
      : null;

  res.json({
    total: avaliacoes.length,
    media,
    avaliacoes,
  });
});

app.get("/modo-humano", protegerRotaInterna, (req, res) => {
  res.json({
    total: modoHumano.size,
    numeros: [...modoHumano],
  });
});

console.log(`🤖 Bot iniciado. TEST_MODE=${TEST_MODE ? "ON" : "OFF"}`);
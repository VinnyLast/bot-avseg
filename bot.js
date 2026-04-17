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
const API_BASE_URL =
  process.env.API_BASE_URL || "http://localhost:10000";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const DELAY_ENVIO_MS = 3000;

const IMAGEM_BOAS_VINDAS = process.env.IMAGEM_URL || "https://raw.githubusercontent.com/VinnyLast/bot-avseg/refs/heads/main/imagem.jpg";

const TEST_MODE = process.env.TEST_MODE === "true";
const ENABLE_CRON = process.env.ENABLE_CRON === "true";
const ALLOWED_NUMBERS = new Set(
  String(process.env.ALLOWED_NUMBERS || "")
    .split(",")
    .map((n) => normalizarTelefoneBR(n))
    .filter(Boolean),
);

// =============================================================================
// ESTADO EM MEMÓRIA
// =============================================================================
const estadoUsuario = {};
const usuariosOptOut = new Set();

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
    console.error(
      `❌ Erro ao enviar texto para ${numero}:`,
      erro.response?.data || erro.message,
    );
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
    console.error(
      `❌ Erro ao enviar imagem para ${numero}:`,
      erro.response?.data || erro.message,
    );
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
// MENSAGENS
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
        `Obrigado por confiar na nossa proteção! 🚗🛡️`
      );

    case "lembrete_5":
      return (
        `Olá ${nome}! 🚗\n\n` +
        `Passando para lembrar que o boleto da sua proteção${
          temPlaca ? ` da placa *${placa}*` : ""
        } vence em *5 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\n_(Para parar de receber lembretes, responda com *0*)_`
      );

    case "lembrete_2":
      return (
        `Atenção ${nome}! 🚨\n\n` +
        `Seu boleto${temPlaca ? ` da placa *${placa}*` : ""} vence em *2 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nJá está com ele em mãos?\n\n_(Para parar de receber lembretes, responda com *0*)_`
      );

    case "vencimento_hoje":
      return (
        `🚨 *Vence hoje!*\n\n` +
        `${nome}, o seu boleto${temPlaca ? ` da placa *${placa}*` : ""} vence *hoje*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento: *${vencimento}*\n` : "") +
        `\nEvite ficar inadimplente. Se precisar da 2ª via, digite *menu*.`
      );

    case "cobranca_atraso":
      return (
        `⚠️ *Aviso de pendência*\n\n` +
        `${nome}, identificamos que o boleto${
          temPlaca ? ` da placa *${placa}*` : ""
        } venceu há *5 dias*.\n` +
        (temValor ? `💰 Valor: *${valor}*\n` : "") +
        (temVenc ? `📅 Vencimento original: *${vencimento}*\n` : "") +
        `\nRegularize para manter sua tranquilidade. Digite *menu* e acesse *Pagamentos*.`
      );

    default:
      return "";
  }
}

// =============================================================================
// MENU
// =============================================================================
async function enviarMenu(numero, cliente) {
  let saudacao = `👋 *AVSEG Proteção Veicular*\n\n`;

  if (
    cliente &&
    !cliente.erro &&
    Array.isArray(cliente.veiculos) &&
    cliente.veiculos.length
  ) {
    saudacao += `Olá *${cliente.nome || "Associado"}*!\n\n🚗 *Seus veículos:*\n\n`;
    cliente.veiculos.forEach((v, i) => {
      saudacao += `${i + 1}️⃣ Placa: ${v.placa || "ND"}\n📅 Vencimento: ${v.vencimento || "ND"}\n\n`;
    });
  }

  saudacao +=
    `Escolha uma opção:\n\n` +
    `1️⃣ Cotação\n` +
    `2️⃣ Pagamentos\n` +
    `3️⃣ Roubo/Furto\n` +
    `4️⃣ Falar com atendente\n` +
    `5️⃣ Encerrar conversa`;

  await enviarImagemSegura(numero, IMAGEM_BOAS_VINDAS, saudacao);
}

// =============================================================================
// PROCESSAMENTO DE MENSAGENS
// =============================================================================
app.on("wa_message", async ({ from, bodyText }) => {
  const texto = String(bodyText || "").toLowerCase().trim();
  const http = axiosInterno();

  // NOVO: Se o usuário mandar algo que parece uma placa, já seta o estado de pagamento automaticamente
  if (parecePlaca(bodyText)) {
    estadoUsuario[from] = "pagamento";
  }
  
  // ... resto do seu código (oi, menu, 1, 2, 3...)

  if (texto === "0" || texto === "parar") {
    usuariosOptOut.add(from);
    estadoUsuario[from] = null;
    await enviarTextoSeguro(
      from,
      `✅ *Notificações preventivas desativadas.*\n\nVocê não receberá mais os lembretes de 5 e 2 dias antes do vencimento.\n\nSe quiser voltar a receber, digite *voltar*.`,
    );
    return;
  }

  if (texto === "voltar") {
    usuariosOptOut.delete(from);
    estadoUsuario[from] = null;
    await enviarTextoSeguro(
      from,
      `✅ *Notificações ativadas com sucesso.*\n\nVocê voltará a receber nossos lembretes preventivos. Obrigado!`,
    );
    return;
  }

  if (["oi", "olá", "ola", "menu"].includes(texto)) {
    estadoUsuario[from] = null;
    let cliente = null;

    try {
      const resposta = await http.post("/clienteTelefone", { telefone: from });
      cliente = resposta.data;
    } catch (erro) {
      console.log("Cliente não encontrado pelo telefone");
    }

    await enviarMenu(from, cliente);
    return;
  }

  if (texto === "1") {
    await enviarTextoSeguro(
      from,
      `📋 *Cotação*\n\nVou encaminhar você para um atendente agora.`,
    );
    return;
  }

  if (texto === "2") {
    estadoUsuario[from] = "pagamento";
    await enviarTextoSeguro(
      from,
      `💳 *Pagamentos*\n\nEnvie:\n\n• CPF do titular\n• CNPJ\nou\n• Placa do veículo`,
    );
    return;
  }

  if (texto === "3") {
    await enviarTextoSeguro(
      from,
      `🚨 *Roubo ou Furto de Veículo*\n\nPara agilizar seu atendimento, entre em contato com nossa central 24h:\n\n📞 *0800 130-0078*\n\nNossa equipe irá te orientar imediatamente. Estamos à disposição! 🤝`,
    );
    return;
  }

  if (texto === "4") {
    await enviarTextoSeguro(
      from,
      `👨‍💻 *Atendente*\n\nUm atendente humano irá continuar seu atendimento em breve.`,
    );
    return;
  }

  if (["5", "encerrar", "finalizar", "sair"].includes(texto)) {
    estadoUsuario[from] = null;
    await enviarTextoSeguro(
      from,
      `✅ *Conversa encerrada.*\n\nQuando quiser falar novamente, é só enviar *oi* ou *menu*.`,
    );
    return;
  }

  if (estadoUsuario[from] === "pagamento") {
    try {
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
        await enviarTextoSeguro(
          from,
          "❌ Envie uma placa, CPF ou CNPJ válido.",
        );
        return;
      }

      let dados;
      try {
        const resposta = await http.post("/boleto", payload);
        dados = resposta.data;
      } catch (erroApi) {
        dados = erroApi.response?.data;
        if (!dados) {
          await enviarTextoSeguro(
            from,
            "❌ Não consegui consultar seu boleto agora. Tente novamente em instantes.",
          );
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
          await enviarTextoSeguro(
            from,
            String(v.linhadigitavel).replace(/\s+/g, ""),
          );
        }

        await delay(500);
        await enviarTextoSeguro(
          from,
          "Digite *5* para encerrar ou *menu* para voltar ao início.",
        );
        estadoUsuario[from] = null;
        return;
      }

      if (dados?.status === "erro" && dados?.mensagemWhatsapp) {
        await enviarTextoSeguro(from, dados.mensagemWhatsapp);
        await delay(500);
        await enviarTextoSeguro(
          from,
          "Digite *5* para encerrar ou *menu* para voltar ao início.",
        );
        estadoUsuario[from] = null;
        return;
      }

      if (
        !dados ||
        !Array.isArray(dados.veiculos) ||
        dados.veiculos.length === 0
      ) {
        await enviarTextoSeguro(
          from,
          `❌ ${dados?.mensagem || "Nenhum registro encontrado."}`,
        );
        estadoUsuario[from] = null;
        return;
      }

      const comBoleto = dados.veiculos.filter(existeBoletoDisponivel);

      if (comBoleto.length === 0) {
        await enviarTextoSeguro(
          from,
          `⚠️ ${dados?.mensagem || "Cadastro encontrado, mas não há boleto em aberto no momento."}`,
        );
        estadoUsuario[from] = null;
        return;
      }

      for (let i = 0; i < comBoleto.length; i++) {
        const v = comBoleto[i];
        await enviarTextoSeguro(from, montarResumoVeiculo(v, i));

        if (existeLinhaDigitavel(v)) {
          await delay(500);
          await enviarTextoSeguro(
            from,
            String(v.linhadigitavel).replace(/\s+/g, ""),
          );
        }

        await delay(DELAY_ENVIO_MS);
      }

      await enviarTextoSeguro(
        from,
        "Digite *5* para encerrar ou *menu* para voltar ao início.",
      );
      estadoUsuario[from] = null;
    } catch (erro) {
      console.error("Erro no fluxo de pagamento:", erro.message);
      await enviarTextoSeguro(
        from,
        "❌ Não consegui consultar seu boleto agora. Tente novamente em instantes.",
      );
      estadoUsuario[from] = null;
    }

    return;
  }

  await enviarTextoSeguro(
    from,
    `Não entendi sua mensagem. Digite *menu* para ver as opções disponíveis.`,
  );
});

// =============================================================================
// CRON
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

        const mensagem = montarMensagemNotificacao(item);
        if (!mensagem) continue;

        await enviarTextoSeguro(telefone, mensagem);
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

  console.log("⏰ CRON habilitado.");
} else {
  console.log("🧪 CRON desabilitado por segurança.");
}

console.log(`🤖 Bot iniciado. TEST_MODE=${TEST_MODE ? "ON" : "OFF"}`);

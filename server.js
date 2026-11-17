import express from "express";
import https from "https";
import axios from "axios";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const EFI_URL = "https://pix.api.efipay.com.br";
const RENDER_URL = "https://meu-checkout-skod.onrender.com";

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));

// Comunicação com o checkout hospedado no Netlify.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.static(__dirname));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function env(name) {
  return (process.env[name] || "").trim();
}

function pem(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim() + "\n";
}

function getAgent() {
  return new https.Agent({
    cert: pem(env("EFI_CERTIFICATE")),
    key: pem(env("EFI_PRIVATE_KEY")),
    minVersion: "TLSv1.2"
  });
}

// Autenticação Efí.
let tokenCache = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (tokenCache && Date.now() < tokenExpiresAt) {
    return tokenCache;
  }

  const response = await axios.post(
    `${EFI_URL}/oauth/token`,
    { grant_type: "client_credentials" },
    {
      httpsAgent: getAgent(),
      auth: {
        username: env("EFI_CLIENT_ID"),
        password: env("EFI_CLIENT_SECRET")
      },
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  tokenCache = response.data.access_token;
  tokenExpiresAt =
    Date.now() + (response.data.expires_in - 60) * 1000;

  return tokenCache;
}

// Configurações do produto.
async function getSettings() {
  const { data, error } = await supabase
    .from("checkout_settings")
    .select("*")
    .eq("id", 1)
    .single();

  if (error) {
    console.error("Erro nas configurações:", error);
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Configurações do produto não encontradas.");
  }

  const price = Number(data.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Preço do produto inválido.");
  }

  return {
    name: data.product_name,
    price: price.toFixed(2),
    accessDays: Number(data.pix_access_days || 30),
    billingInterval: data.card_billing_interval || "monthly",
    driveUrl: data.drive_url || null
  };
}

// Cria o acesso ao produto após pagamento confirmado.
async function createAccess(order) {
  const { data: product, error: productError } = await supabase
    .from("checkout_products")
    .select("id, drive_url")
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (productError) throw productError;

  if (!product) {
    console.log(
      "Pedido pago, mas ainda não existe produto ativo cadastrado."
    );
    return;
  }

  const { data: existing, error: existingError } = await supabase
    .from("checkout_access")
    .select("id")
    .eq("order_id", order.id)
    .eq("product_id", product.id)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return;

  const settings = await getSettings();
  const paidAt = order.paid_at
    ? new Date(order.paid_at)
    : new Date();

  const expiresAt = new Date(
    paidAt.getTime() + settings.accessDays * 24 * 60 * 60 * 1000
  );

  const accessToken = crypto.randomBytes(32).toString("hex");

  const { error: insertError } = await supabase
    .from("checkout_access")
    .insert({
      order_id: order.id,
      customer_email: order.customer_email,
      product_id: product.id,
      access_token: accessToken,
      expires_at: expiresAt.toISOString()
    });

  if (insertError) throw insertError;

  console.log("Acesso criado para o pedido:", order.id);
}

// Página inicial.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Teste de autenticação da Efí.
app.get("/efi/teste", async (req, res) => {
  try {
    await getToken();

    res.json({
      status: "sucesso",
      mensagem: "Autenticação realizada!"
    });
  } catch (error) {
    console.error(
      "Erro de autenticação:",
      error.response?.data || error.message
    );

    res.status(502).json({
      status: "erro",
      codigo: error.response?.status || error.code || "CONEXAO",
      detalhe: error.response?.data || error.message
    });
  }
});

// Consulta produto e preço.
app.get("/api/produto", async (req, res) => {
  try {
    const settings = await getSettings();

    res.json({
      nome: settings.name,
      preco: settings.price,
      dias_acesso_pix: settings.accessDays,
      intervalo_cartao: settings.billingInterval
    });
  } catch (error) {
    console.error("Erro ao consultar produto:", error.message);

    res.status(500).json({
      erro: "Não foi possível carregar o produto."
    });
  }
});

// Criação de cobrança Pix.
app.post("/api/pix/criar", async (req, res) => {
  let orderId = null;

  try {
    const nome = String(req.body?.nome || "").trim();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");
    const telefone = String(req.body?.telefone || "")
      .replace(/\D/g, "");

    if (!nome || !email || !cpf || !telefone) {
      return res.status(400).json({
        erro: "Preencha nome, e-mail, CPF e telefone."
      });
    }

    if (cpf.length !== 11) {
      return res.status(400).json({
        erro: "CPF inválido."
      });
    }

    if (!env("EFI_PIX_KEY")) {
      throw new Error("Chave Pix não configurada.");
    }

    const settings = await getSettings();

    const txid = crypto.randomBytes(13).toString("hex");
    const expiresAt = new Date(
      Date.now() + 30 * 60 * 1000
    ).toISOString();

    const { data: pedido, error: insertError } = await supabase
      .from("checkout_orders")
      .insert({
        customer_name: nome,
        customer_email: email,
        customer_cpf: cpf,
        customer_phone: telefone,
        payment_method: "pix",
        amount: Number(settings.price),
        status: "pending",
        payment_id: txid,
        expires_at: expiresAt
      })
      .select("id")
      .single();

    if (insertError) throw insertError;

    orderId = pedido.id;

    const token = await getToken();

    const cobranca = await axios.put(
      `${EFI_URL}/v2/cob/${txid}`,
      {
        calendario: { expiracao: 1800 },
        devedor: { cpf, nome },
        valor: { original: settings.price },
        chave: env("EFI_PIX_KEY"),
        solicitacaoPagador: "Pagamento do produto digital"
      },
      {
        httpsAgent: getAgent(),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    if (!cobranca.data?.loc?.id) {
      throw new Error("A Efí não retornou o QR Code.");
    }

    const qr = await axios.get(
      `${EFI_URL}/v2/loc/${cobranca.data.loc.id}/qrcode`,
      {
        httpsAgent: getAgent(),
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 30000
      }
    );

    res.json({
      sucesso: true,
      pedido_id: orderId,
      txid,
      produto: settings.name,
      valor: settings.price,
      expiracao_segundos: 1800,
      expira_em: expiresAt,
      pix_copia_e_cola: qr.data.qrcode,
      imagem_qrcode: qr.data.imagemQrcode,
      link_visualizacao: qr.data.linkVisualizacao
    });

  } catch (error) {
    console.error(
      "Erro ao criar Pix:",
      error.response?.data || error.message
    );

    if (orderId) {
      await supabase
        .from("checkout_orders")
        .update({ status: "failed" })
        .eq("id", orderId);
    }

    res.status(500).json({
      sucesso: false,
      erro: "Não foi possível gerar o Pix.",
      detalhe: error.response?.data || error.message
    });
  }
});

// Recebe notificações Pix da Efí.
app.post("/webhook", async (req, res) => {
  try {
    const recebido = String(req.query.hmac || "");
    const esperado = env("EFI_WEBHOOK_SECRET");

    if (
      !esperado ||
      recebido.length !== esperado.length ||
      !crypto.timingSafeEqual(
        Buffer.from(recebido),
        Buffer.from(esperado)
      )
    ) {
      return res.sendStatus(401);
    }

    const pixRecebidos = req.body?.pix;

    // Notificação de teste da Efí.
    if (!Array.isArray(pixRecebidos)) {
      return res.sendStatus(200);
    }

    const token = await getToken();

    for (const pix of pixRecebidos) {
      const txid = String(pix.txid || "");
      const valorRecebido = Number(pix.valor);

      if (
        !txid ||
        !Number.isFinite(valorRecebido) ||
        String(pix.chave || "") !== env("EFI_PIX_KEY")
      ) {
        continue;
      }

      const { data: pedido, error: buscaErro } = await supabase
        .from("checkout_orders")
        .select("*")
        .eq("payment_id", txid)
        .eq("payment_method", "pix")
        .maybeSingle();

      if (buscaErro) throw buscaErro;
      if (!pedido) continue;

      if (
        Math.abs(Number(pedido.amount) - valorRecebido) > 0.001
      ) {
        console.error("Valor diferente do pedido:", txid);
        continue;
      }

      // Confere o estado da cobrança diretamente na Efí.
      const consulta = await axios.get(
        `${EFI_URL}/v2/cob/${txid}`,
        {
          httpsAgent: getAgent(),
          headers: {
            Authorization: `Bearer ${token}`
          },
          timeout: 30000
        }
      );

      const cobranca = consulta.data;

      if (
        cobranca.status !== "CONCLUIDA" ||
        Math.abs(
          Number(cobranca.valor?.original) - Number(pedido.amount)
        ) > 0.001
      ) {
        console.log("Cobrança ainda não confirmada:", txid);
        continue;
      }

      let pedidoAtualizado = pedido;

      if (pedido.status === "pending") {
        const paidAt = new Date().toISOString();

        const { data: atualizado, error: updateErro } =
          await supabase
            .from("checkout_orders")
            .update({
              status: "paid",
              paid_at: paidAt
            })
            .eq("id", pedido.id)
            .eq("status", "pending")
            .select("*")
            .maybeSingle();

        if (updateErro) throw updateErro;

        if (atualizado) {
          pedidoAtualizado = atualizado;
        } else {
          const { data: atual, error: atualErro } = await supabase
            .from("checkout_orders")
            .select("*")
            .eq("id", pedido.id)
            .single();

          if (atualErro) throw atualErro;
          pedidoAtualizado = atual;
        }
      }

      if (pedidoAtualizado.status === "paid") {
        await createAccess(pedidoAtualizado);
      }
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error(
      "Erro no webhook Efí:",
      error.response?.data || error.message
    );

    return res.sendStatus(500);
  }
});

// Entrega protegida do produto.
app.get("/acesso/:token", async (req, res) => {
  try {
    const { data: acesso, error } = await supabase
      .from("checkout_access")
      .select(`
        access_token,
        expires_at,
        product:checkout_products(drive_url),
        pedido:checkout_orders!inner(status)
      `)
      .eq("access_token", req.params.token)
      .maybeSingle();

    if (error) throw error;

    if (
      !acesso ||
      acesso.pedido?.status !== "paid" ||
      new Date(acesso.expires_at) <= new Date()
    ) {
      return res.status(403).send("Acesso inválido ou expirado.");
    }

    const settings = await getSettings();
    const driveUrl =
      acesso.product?.drive_url || settings.driveUrl;

    if (!driveUrl) {
      return res.status(503).send(
        "O link do produto ainda não foi configurado."
      );
    }

    return res.redirect(302, driveUrl);

  } catch (error) {
    console.error("Erro ao liberar acesso:", error.message);
    return res.status(500).send("Não foi possível liberar o acesso.");
  }
});

// Cadastro automático do webhook na Efí.
async function registerWebhook() {
  try {
    const secret = env("EFI_WEBHOOK_SECRET");
    const pixKey = env("EFI_PIX_KEY");

    if (!secret || !pixKey) {
      console.log("Webhook não cadastrado: faltam variáveis.");
      return;
    }

    const token = await getToken();

    const webhookUrl =
      `${RENDER_URL}/webhook?hmac=${encodeURIComponent(secret)}&ignorar=`;

    await axios.put(
      `${EFI_URL}/v2/webhook/${encodeURIComponent(pixKey)}`,
      { webhookUrl },
      {
        httpsAgent: getAgent(),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-skip-mtls-checking": "true"
        },
        timeout: 30000
      }
    );

    console.log("Webhook Pix cadastrado na Efí com sucesso.");
  } catch (error) {
    console.error(
      "Não foi possível cadastrar o webhook:",
      error.response?.data || error.message
    );
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Meu Checkout iniciado na porta " + PORT);
  registerWebhook();
});

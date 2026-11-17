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

app.use(express.json({ limit: "100kb" }));
// Permitir comunicação entre Netlify e Render
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

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
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    }
  );

  tokenCache = response.data.access_token;
  tokenExpiresAt =
    Date.now() + (response.data.expires_in - 60) * 1000;

  return tokenCache;
}

async function getSettings() {
  const { data, error } = await supabase
    .from("checkout_settings")
    .select("*")
    .eq("id", 1)
    .single();

  if (error) {
    console.error("ERRO REAL DO SUPABASE:", error);
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Nenhuma configuração encontrada com id 1.");
  }

  const price = Number(data.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("O preço configurado é inválido.");
  }

  return {
    name: data.product_name,
    price: price.toFixed(2),
    accessDays: Number(data.pix_access_days || 30),
    billingInterval: data.card_billing_interval || "monthly",
    driveUrl: data.drive_url || null
  };
}

// Abre a página do checkout.
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

// Consulta produto e preço no Supabase.
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
      return res.status(400).json({ erro: "CPF inválido." });
    }

    if (!env("EFI_PIX_KEY")) {
      throw new Error("Chave Pix não configurada no servidor.");
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
      throw new Error("A Efí não retornou o identificador do QR Code.");
    }

    const qr = await axios.get(
      `${EFI_URL}/v2/loc/${cobranca.data.loc.id}/qrcode`,
      {
        httpsAgent: getAgent(),
        headers: { Authorization: `Bearer ${token}` },
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Meu Checkout iniciado na porta " + PORT);
});

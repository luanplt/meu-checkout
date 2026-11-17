import express from "express";
import https from "https";
import axios from "axios";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 10000;
const EFI_URL = "https://pix.api.efipay.com.br";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function env(name) {
  return (process.env[name] || "").trim();
}

function pem(value) {
  return value.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim() + "\n";
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
  tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;

  return tokenCache;
}

app.get("/", (req, res) => {
  res.json({ status: "online", service: "Meu Checkout" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Teste de autenticação: não cria cobrança.
app.get("/efi/teste", async (req, res) => {
  try {
    await getToken();
    res.json({
      status: "sucesso",
      mensagem: "Autenticação realizada!"
    });
  } catch (error) {
    res.status(502).json({
      status: "erro",
      codigo: error.response?.status || error.code || "CONEXAO",
      detalhe: error.response?.data || error.message
    });
  }
});

// Criação de cobrança Pix em produção.
app.post("/api/pix/criar", async (req, res) => {
  let orderId;

  try {
    const { nome, email, cpf, telefone } = req.body || {};

    const nomeCliente = String(nome || "").trim();
    const emailCliente = String(email || "").trim().toLowerCase();
    const cpfCliente = String(cpf || "").replace(/\D/g, "");
    const telefoneCliente = String(telefone || "").replace(/\D/g, "");

    if (!nomeCliente || !emailCliente || !cpfCliente || !telefoneCliente) {
      return res.status(400).json({
        erro: "Preencha nome, email, CPF e telefone."
      });
    }

    if (cpfCliente.length !== 11) {
      return res.status(400).json({ erro: "CPF inválido." });
    }

    if (!env("EFI_PIX_KEY")) {
      return res.status(500).json({ erro: "Chave Pix não configurada." });
    }

    const txid = crypto.randomBytes(13).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const { data: pedido, error: dbError } = await supabase
      .from("checkout_orders")
      .insert({
        customer_name: nomeCliente,
        customer_email: emailCliente,
        customer_cpf: cpfCliente,
        customer_phone: telefoneCliente,
        payment_method: "pix",
        amount: 13.99,
        status: "pending",
        payment_id: txid,
        expires_at: expiresAt
      })
      .select("id")
      .single();

    if (dbError) throw dbError;

    orderId = pedido.id;

    const token = await getToken();

    const cobranca = await axios.put(
      `${EFI_URL}/v2/cob/${txid}`,
      {
        calendario: {
          expiracao: 1800
        },
        devedor: {
          cpf: cpfCliente,
          nome: nomeCliente
        },
        valor: {
          original: "13.99"
        },
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

    return res.json({
      sucesso: true,
      pedido_id: orderId,
      txid,
      valor: "13.99",
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

    return res.status(500).json({
      sucesso: false,
      erro: "Não foi possível gerar o Pix.",
      detalhe: error.response?.data || error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Meu Checkout iniciado na porta " + PORT);
});

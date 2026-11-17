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
const RENDER_URL = (process.env.RENDER_URL || "https://meu-checkout-skod.onrender.com").replace(/\/$/, "");
const STORAGE_BUCKET = "product-media";
const PUBLIC_SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_VqPxfvYCKayVH2qwRBx-Pg_c_CrgGkh";

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

function env(name) {
  return (process.env[name] || "").trim();
}

const supabaseUrl = env("SUPABASE_URL");
const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Faltam SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY no Render.");
}
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

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
  if (tokenCache && Date.now() < tokenExpiresAt) return tokenCache;

  const response = await axios.post(
    `${EFI_URL}/oauth/token`,
    { grant_type: "client_credentials" },
    {
      httpsAgent: getAgent(),
      auth: { username: env("EFI_CLIENT_ID"), password: env("EFI_CLIENT_SECRET") },
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    }
  );

  tokenCache = response.data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, response.data.expires_in - 60) * 1000;
  return tokenCache;
}

async function getSettings() {
  const { data, error } = await supabase
    .from("checkout_settings")
    .select("*")
    .eq("id", 1)
    .single();

  if (error) throw new Error(`Erro nas configurações: ${error.message}`);
  if (!data) throw new Error("Configurações do produto não encontradas.");

  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Preço do produto inválido.");

  return {
    name: data.product_name || "Meu Produto",
    price: price.toFixed(2),
    accessDays: Math.max(1, Number(data.pix_access_days || 30)),
    billingInterval: data.card_billing_interval || "monthly",
    driveUrl: data.drive_url || null,
    coverUrl: data.cover_url || null,
    galleryUrls: Array.isArray(data.gallery_urls) ? data.gallery_urls : [],
    backgroundUrl: data.background_url || null
  };
}

async function getActiveProduct() {
  const { data, error } = await supabase
    .from("checkout_products")
    .select("id, name, drive_url")
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createAccess(order) {
  const product = await getActiveProduct();
  if (!product) {
    console.error("Pedido pago, mas não existe produto ativo cadastrado.");
    return null;
  }

  const { data: existing, error: existingError } = await supabase
    .from("checkout_access")
    .select("access_token, expires_at")
    .eq("order_id", order.id)
    .eq("product_id", product.id)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing.access_token;

  const settings = await getSettings();
  const paidAt = order.paid_at ? new Date(order.paid_at) : new Date();
  const expiresAt = new Date(paidAt.getTime() + settings.accessDays * 86400000);
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

  if (insertError) {
    // Webhooks podem ser reenviados; em caso de duplicidade, recupera o acesso existente.
    if (insertError.code === "23505") {
      const { data: duplicate } = await supabase
        .from("checkout_access")
        .select("access_token")
        .eq("order_id", order.id)
        .eq("product_id", product.id)
        .maybeSingle();
      return duplicate?.access_token || null;
    }
    throw insertError;
  }

  console.log("Acesso criado para o pedido:", order.id);
  return accessToken;
}

async function requireAdmin(req, res, next) {
  try {
    const authorization = String(req.headers.authorization || "");
    const jwt = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!jwt) return res.status(401).json({ erro: "Faça login para continuar." });

    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ erro: "Sessão inválida. Entre novamente." });

    const adminUid = env("ADMIN_UID");
    if (!adminUid || data.user.id !== adminUid) {
      return res.status(403).json({ erro: "Este usuário não tem permissão de administrador." });
    }

    req.adminUser = data.user;
    next();
  } catch (error) {
    console.error("Falha na autenticação administrativa:", error.message);
    return res.status(401).json({ erro: "Não foi possível validar seu acesso." });
  }
}

async function saveProductRow(name, driveUrl) {
  const { data: current, error: readError } = await supabase
    .from("checkout_products")
    .select("id")
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (readError) throw readError;

  if (current?.id) {
    const { error } = await supabase
      .from("checkout_products")
      .update({ name, drive_url: driveUrl, active: true, updated_at: new Date().toISOString() })
      .eq("id", current.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("checkout_products")
      .insert({ name, drive_url: driveUrl, active: true, updated_at: new Date().toISOString() });
    if (error) throw error;
  }
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (req, res) => res.json({ status: "ok", service: "Meu Checkout" }));

app.get("/api/config-public", (req, res) => {
  res.json({
    supabaseUrl,
    supabaseKey: PUBLIC_SUPABASE_KEY,
    storageBucket: STORAGE_BUCKET
  });
});

app.get("/efi/teste", async (req, res) => {
  try {
    await getToken();
    res.json({ status: "sucesso", mensagem: "Autenticação Pix realizada." });
  } catch (error) {
    console.error("Erro Efí:", error.response?.data || error.message);
    res.status(502).json({
      status: "erro",
      codigo: error.response?.status || error.code || "CONEXAO",
      detalhe: error.response?.data || error.message
    });
  }
});

app.get("/api/produto", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      nome: settings.name,
      preco: settings.price,
      dias_acesso_pix: settings.accessDays,
      intervalo_cartao: settings.billingInterval,
      capa: settings.coverUrl,
      galeria: settings.galleryUrls,
      fundo: settings.backgroundUrl
    });
  } catch (error) {
    console.error("Erro ao consultar produto:", error.message);
    res.status(500).json({ erro: "Não foi possível carregar o produto." });
  }
});

// Dados do painel: somente o administrador autenticado.
app.get("/api/admin/config", requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    console.error("Erro ao carregar painel:", error.message);
    res.status(500).json({ erro: "Não foi possível carregar as configurações." });
  }
});

app.put("/api/admin/config", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const driveUrl = String(req.body?.driveUrl || "").trim();
    const price = Number(req.body?.price);
    const accessDays = Number(req.body?.accessDays);
    const coverUrl = req.body?.coverUrl ? String(req.body.coverUrl) : null;
    const backgroundUrl = req.body?.backgroundUrl ? String(req.body.backgroundUrl) : null;
    const galleryUrls = Array.isArray(req.body?.galleryUrls)
      ? req.body.galleryUrls.filter(v => typeof v === "string").slice(0, 20)
      : [];

    if (!name) return res.status(400).json({ erro: "Informe o nome do produto." });
    if (!Number.isFinite(price) || price <= 0 || price > 100000) {
      return res.status(400).json({ erro: "Informe um preço válido." });
    }
    if (!Number.isInteger(accessDays) || accessDays < 1 || accessDays > 3650) {
      return res.status(400).json({ erro: "Informe uma validade entre 1 e 3650 dias." });
    }
    if (driveUrl && !/^https:\/\/(drive\.google\.com|docs\.google\.com)\//i.test(driveUrl)) {
      return res.status(400).json({ erro: "Use um link válido do Google Drive." });
    }

    const updates = {
      product_name: name,
      price: price.toFixed(2),
      pix_access_days: accessDays,
      drive_url: driveUrl || null,
      cover_url: coverUrl,
      gallery_urls: galleryUrls,
      background_url: backgroundUrl,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from("checkout_settings")
      .update(updates)
      .eq("id", 1);
    if (error) throw error;

    await saveProductRow(name, driveUrl || null);
    res.json({ sucesso: true, mensagem: "Configurações salvas." });
  } catch (error) {
    console.error("Erro ao salvar configurações:", error.message);
    res.status(500).json({ erro: "Não foi possível salvar. Confira as permissões das tabelas." });
  }
});

// Criação de cobrança Pix.
app.post("/api/pix/criar", async (req, res) => {
  let orderId = null;
  try {
    const nome = String(req.body?.nome || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");
    const telefone = String(req.body?.telefone || "").replace(/\D/g, "");

    if (!nome || !email || !cpf || !telefone) {
      return res.status(400).json({ erro: "Preencha nome, e-mail, CPF e telefone." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ erro: "E-mail inválido." });
    }
    if (cpf.length !== 11) return res.status(400).json({ erro: "CPF inválido." });
    if (!env("EFI_PIX_KEY")) throw new Error("Chave Pix não configurada.");

    const settings = await getSettings();
    const txid = crypto.randomBytes(13).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

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
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 30000
      }
    );

    if (!cobranca.data?.loc?.id) throw new Error("A Efí não retornou o QR Code.");

    const qr = await axios.get(`${EFI_URL}/v2/loc/${cobranca.data.loc.id}/qrcode`, {
      httpsAgent: getAgent(),
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });

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
    console.error("Erro ao criar Pix:", error.response?.data || error.message);
    if (orderId) {
      await supabase.from("checkout_orders").update({ status: "failed" }).eq("id", orderId);
    }
    res.status(500).json({
      sucesso: false,
      erro: "Não foi possível gerar o Pix.",
      detalhe: error.response?.data?.mensagem || error.message
    });
  }
});

// Consulta do pedido pelo próprio comprador; libera link apenas após confirmação.
app.post("/api/pedido/status", async (req, res) => {
  try {
    const orderId = String(req.body?.pedido_id || "");
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!orderId || !email) return res.status(400).json({ erro: "Pedido e e-mail são obrigatórios." });

    const { data: order, error } = await supabase
      .from("checkout_orders")
      .select("id, customer_email, status, paid_at")
      .eq("id", orderId)
      .eq("customer_email", email)
      .maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ erro: "Pedido não encontrado." });

    let accessUrl = null;
    if (order.status === "paid") {
      const product = await getActiveProduct();
      if (product) {
        const { data: access, error: accessError } = await supabase
          .from("checkout_access")
          .select("access_token, expires_at")
          .eq("order_id", order.id)
          .eq("product_id", product.id)
          .maybeSingle();
        if (accessError) throw accessError;
        if (access && new Date(access.expires_at) > new Date()) {
          accessUrl = `${RENDER_URL}/acesso/${access.access_token}`;
        }
      }
    }
    res.json({ status: order.status, acesso: accessUrl });
  } catch (error) {
    console.error("Erro ao consultar pedido:", error.message);
    res.status(500).json({ erro: "Não foi possível consultar o pedido." });
  }
});

// Webhook Pix da Efí.
app.post("/webhook", async (req, res) => {
  try {
    const recebido = String(req.query.hmac || "");
    const esperado = env("EFI_WEBHOOK_SECRET");
    if (!esperado || recebido.length !== esperado.length ||
      !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
      return res.sendStatus(401);
    }

    const pixRecebidos = req.body?.pix;
    if (!Array.isArray(pixRecebidos)) return res.sendStatus(200);

    const token = await getToken();
    for (const pix of pixRecebidos) {
      const txid = String(pix.txid || "");
      const valorRecebido = Number(pix.valor);
      if (!txid || !Number.isFinite(valorRecebido) ||
        String(pix.chave || "") !== env("EFI_PIX_KEY")) continue;

      const { data: pedido, error: buscaErro } = await supabase
        .from("checkout_orders")
        .select("*")
        .eq("payment_id", txid)
        .eq("payment_method", "pix")
        .maybeSingle();
      if (buscaErro) throw buscaErro;
      if (!pedido || Math.abs(Number(pedido.amount) - valorRecebido) > 0.001) continue;

      const consulta = await axios.get(`${EFI_URL}/v2/cob/${txid}`, {
        httpsAgent: getAgent(),
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000
      });

      const cobranca = consulta.data;
      if (cobranca.status !== "CONCLUIDA" ||
        Math.abs(Number(cobranca.valor?.original) - Number(pedido.amount)) > 0.001) continue;

      let pedidoAtualizado = pedido;
      if (pedido.status !== "paid") {
        const paidAt = new Date().toISOString();
        const { data: atualizado, error: updateError } = await supabase
          .from("checkout_orders")
          .update({ status: "paid", paid_at: paidAt })
          .eq("id", pedido.id)
          .eq("status", "pending")
          .select("*")
          .maybeSingle();
        if (updateError) throw updateError;
        if (atualizado) pedidoAtualizado = atualizado;
        else {
          const { data: atual, error: atualError } = await supabase
            .from("checkout_orders").select("*").eq("id", pedido.id).single();
          if (atualError) throw atualError;
          pedidoAtualizado = atual;
        }
      }
      if (pedidoAtualizado.status === "paid") await createAccess(pedidoAtualizado);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook Pix:", error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

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

    if (!acesso || acesso.pedido?.status !== "paid" ||
      new Date(acesso.expires_at) <= new Date()) {
      return res.status(403).send("Acesso inválido ou expirado.");
    }

    const settings = await getSettings();
    const driveUrl = acesso.product?.drive_url || settings.driveUrl;
    if (!driveUrl) return res.status(503).send("O link do produto ainda não foi configurado.");
    return res.redirect(302, driveUrl);
  } catch (error) {
    console.error("Erro ao liberar acesso:", error.message);
    return res.status(500).send("Não foi possível liberar o acesso.");
  }
});

async function registerWebhook() {
  try {
    const secret = env("EFI_WEBHOOK_SECRET");
    const pixKey = env("EFI_PIX_KEY");
    if (!secret || !pixKey) {
      console.log("Webhook Pix não cadastrado: faltam variáveis.");
      return;
    }

    const token = await getToken();
    const webhookUrl = `${RENDER_URL}/webhook?hmac=${encodeURIComponent(secret)}&ignorar=`;
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
    console.log("Webhook Pix cadastrado na Efí.");
  } catch (error) {
    console.error("Não foi possível cadastrar webhook Pix:", error.response?.data || error.message);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Meu Checkout iniciado na porta ${PORT}`);
  registerWebhook();
});

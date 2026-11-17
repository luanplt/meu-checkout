import express from "express";
import https from "https";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Meu Checkout"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function obterVariavel(nome) {
  return (process.env[nome] || "").trim();
}

function ajustarPem(valor) {
  return valor
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim() + "\n";
}

// Diagnóstico e autenticação de produção Efí
app.get("/efi/teste", async (req, res) => {
  const clientId = obterVariavel("EFI_CLIENT_ID");
  const clientSecret = obterVariavel("EFI_CLIENT_SECRET");
  const certificado = ajustarPem(obterVariavel("EFI_CERTIFICATE"));
  const chavePrivada = ajustarPem(obterVariavel("EFI_PRIVATE_KEY"));

  const problemas = [];

  if (!clientId) problemas.push("EFI_CLIENT_ID");
  if (!clientSecret) problemas.push("EFI_CLIENT_SECRET");

  if (!certificado.includes("-----BEGIN CERTIFICATE-----") ||
      !certificado.includes("-----END CERTIFICATE-----")) {
    problemas.push("EFI_CERTIFICATE");
  }

  if (
    !chavePrivada.includes("-----BEGIN PRIVATE KEY-----") &&
    !chavePrivada.includes("-----BEGIN RSA PRIVATE KEY-----")
  ) {
    problemas.push("EFI_PRIVATE_KEY");
  }

  if (problemas.length > 0) {
    return res.status(500).json({
      status: "erro",
      mensagem: "Confira as variáveis no Render.",
      variaveis_com_problema: problemas
    });
  }

  try {
    const agent = new https.Agent({
      cert: certificado,
      key: chavePrivada,
      minVersion: "TLSv1.2"
    });

    const resposta = await axios.post(
      "https://pix.api.efipay.com.br/oauth/token",
      { grant_type: "client_credentials" },
      {
        httpsAgent: agent,
        auth: {
          username: clientId,
          password: clientSecret
        },
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    return res.json({
      status: "sucesso",
      mensagem: "Autenticação com a Efí realizada!",
      token_type: resposta.data.token_type,
      expires_in: resposta.data.expires_in
    });

  } catch (erro) {
    console.error(
      "Falha Efí:",
      erro.response?.status || erro.code || "Erro de conexão"
    );

    return res.status(502).json({
      status: "erro",
      mensagem: "Falha na autenticação com a Efí.",
      codigo: erro.response?.status || erro.code || "CONEXAO"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Meu Checkout iniciado na porta " + PORT);
});

import express from "express";
import https from "https";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.json({ status: "online", service: "Meu Checkout" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function env(nome) {
  return (process.env[nome] || "").trim();
}

function pem(valor) {
  return valor.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim() + "\n";
}

app.get("/efi/teste", async (req, res) => {
  try {
    const cert = pem(env("EFI_CERTIFICATE"));
    const key = pem(env("EFI_PRIVATE_KEY"));

    const agent = new https.Agent({
      cert,
      key,
      minVersion: "TLSv1.2"
    });

    const resposta = await axios.post(
      "https://pix.api.efipay.com.br/oauth/token",
      { grant_type: "client_credentials" },
      {
        httpsAgent: agent,
        auth: {
          username: env("EFI_CLIENT_ID"),
          password: env("EFI_CLIENT_SECRET")
        },
        headers: { "Content-Type": "application/json" },
        timeout: 30000
      }
    );

    return res.json({
      status: "sucesso",
      mensagem: "Autenticação realizada!",
      expires_in: resposta.data.expires_in
    });
  } catch (erro) {
    console.error("Detalhe Efí:", erro.response?.data || erro.message);

    return res.status(502).json({
      status: "erro",
      codigo: erro.response?.status || erro.code || "CONEXAO",
      detalhe: erro.response?.data?.error_description ||
               erro.response?.data?.error ||
               erro.code ||
               "Falha na conexão"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Meu Checkout iniciado na porta " + PORT);
});

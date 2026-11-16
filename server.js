import express from "express";
import https from "https";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "online", service: "Meu Checkout" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Teste de autenticação Efí — não gera cobranças
app.get("/efi/teste", async (req, res) => {
  try {
    const { EFI_CLIENT_ID, EFI_CLIENT_SECRET, EFI_CERTIFICATE, EFI_PRIVATE_KEY } = process.env;

    if (!EFI_CLIENT_ID || !EFI_CLIENT_SECRET || !EFI_CERTIFICATE || !EFI_PRIVATE_KEY) {
      return res.status(500).json({
        status: "erro",
        mensagem: "Faltam configurações da Efí no servidor."
      });
    }

    const agent = new https.Agent({
      cert: EFI_CERTIFICATE,
      key: EFI_PRIVATE_KEY
    });

    const resposta = await axios.post(
      "https://pix.api.efipay.com.br/oauth/token",
      { grant_type: "client_credentials" },
      {
        httpsAgent: agent,
        auth: {
          username: EFI_CLIENT_ID,
          password: EFI_CLIENT_SECRET
        },
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    res.json({
      status: "sucesso",
      mensagem: "Autenticação com a Efí realizada!",
      token_type: resposta.data.token_type,
      expires_in: resposta.data.expires_in,
      scope: resposta.data.scope
    });

  } catch (erro) {
    console.error("Erro na autenticação Efí:", erro.response?.status || erro.code || "Erro");

    res.status(502).json({
      status: "erro",
      mensagem: "Não foi possível autenticar com a Efí.",
      codigo: erro.response?.status || erro.code || "indisponível"
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});

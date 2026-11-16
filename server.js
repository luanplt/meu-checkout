import express from "express";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Meu Checkout"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});

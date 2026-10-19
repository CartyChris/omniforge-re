const express = require("express");
const app = express();
app.get("/api/items", (req, res) => res.json([req.query.page]));
app.post("/api/items/:id/comments", (req, res) => res.json(req.body));
app.listen(3000);

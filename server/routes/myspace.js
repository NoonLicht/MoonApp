const express = require("express");
const vault = require("../myspace-vault");
const logger = require("../logger");

const router = express.Router();

// GET /api/myspace/tree — file tree
router.get("/tree", (req, res) => {
  try { res.json(vault.buildTree()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/myspace/file?path=... — read file
router.get("/file", (req, res) => {
  try {
    const f = vault.readFile(req.query.path);
    if (!f) return res.status(404).json({ error: "not found" });
    const outline = vault.getOutline(f.content);
    const backlinks = vault.getBacklinks(req.query.path);
    res.json({ ...f, outline, backlinks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/myspace/file — create or update file
router.post("/file", (req, res) => {
  try {
    const { path: filePath, content, frontmatter } = req.body || {};
    if (!filePath) return res.status(400).json({ error: "path required" });
    const result = vault.writeFile(filePath, content || "", frontmatter || {});
    logger.action("myspace.write", { path: filePath });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/myspace/file?path=...
router.delete("/file", (req, res) => {
  try {
    const result = vault.deleteFile(req.query.path);
    if (!result.ok) return res.status(404).json(result);
    logger.action("myspace.delete", { path: req.query.path });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/myspace/rename
router.put("/rename", (req, res) => {
  try {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath) return res.status(400).json({ error: "oldPath and newPath required" });
    const result = vault.renameFile(oldPath, newPath);
    logger.action("myspace.rename", { oldPath, newPath });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/myspace/folder
router.post("/folder", (req, res) => {
  try {
    const { path: folderPath } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: "path required" });
    res.json(vault.createFolder(folderPath));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/myspace/search?q=...
router.get("/search", (req, res) => {
  try { res.json(vault.searchFiles(req.query.q)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/myspace/tags
router.get("/tags", (req, res) => {
  try { res.json(vault.getAllTags()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== Holst / Canvas ====================

// GET /api/myspace/holsts — list all .holst files
router.get("/holsts", (req, res) => {
  try { res.json(vault.listHolsts()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/myspace/holst?name=... — read a .holst file
router.get("/holst", (req, res) => {
  try {
    const result = vault.readHolst(req.query.name);
    if (!result) return res.status(404).json({ error: "not found" });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/myspace/holst — write a .holst file
router.post("/holst", (req, res) => {
  try {
    const { name, data } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const result = vault.writeHolst(name, data || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/myspace/holst?name=...
router.delete("/holst", (req, res) => {
  try {
    const result = vault.deleteHolst(req.query.name);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
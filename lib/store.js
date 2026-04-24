const fs = require("fs");
const path = require("path");

function resolvePath(fileName) {
  return path.join(__dirname, "..", "data", fileName);
}

function readJson(fileName) {
  const filePath = resolvePath(fileName);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]", "utf8");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

function writeJson(fileName, payload) {
  const filePath = resolvePath(fileName);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

module.exports = {
  readJson,
  writeJson,
};

exports.apply = async (c, sql) => {
  const triggers = [];
  sql = sql
    .replace(/^[ \t]*--.*$/gm, "")
    .replace(/CREATE TRIGGER[\s\S]*?^END;/gm, (t) => {
      triggers.push(t);
      return "";
    });
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const alter = statement.match(/^ALTER TABLE (\w+)\s+([\s\S]*)/i);
    if (alter && alter[2].includes("ADD CONSTRAINT")) {
      for (const clause of alter[2].split(/,\s*ADD CONSTRAINT/i)) {
        const cleaned = clause.trim();
        const value = cleaned.startsWith("ADD CONSTRAINT")
          ? cleaned
          : "ADD CONSTRAINT " + cleaned;
        const name = value.match(/^ADD CONSTRAINT (\w+)/i)?.[1];
        if (!name) throw Error("Invalid constraint migration");
        const [[old]] = await c.execute(
          "SELECT COUNT(*) n FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name=?",
          [alter[1], name],
        );
        if (!old.n) await c.query("ALTER TABLE " + alter[1] + " " + value);
      }
    } else await c.query(statement);
  }
  for (const t of triggers) {
    const name = t.match(/^CREATE TRIGGER (\w+)/i)[1];
    const [[old]] = await c.execute(
      "SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name=?",
      [name],
    );
    if (!old.n) await c.query(t);
  }
};

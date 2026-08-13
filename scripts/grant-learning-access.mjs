import mysql from "mysql2/promise";

const email = process.env.CUSTOMER_EMAIL?.trim().toLowerCase();
const courseSlug = process.env.COURSE_SLUG?.trim();
if (!process.env.MYSQL_URL || !email || !courseSlug) throw new Error("MYSQL_URL, CUSTOMER_EMAIL and COURSE_SLUG are required.");
const db = await mysql.createConnection({ uri: process.env.MYSQL_URL });
try {
  const [[customer]] = await db.query("SELECT id FROM customers WHERE email=?", [email]);
  if (!customer) throw new Error("Customer not found.");
  const [[course]] = await db.query("SELECT course_slug FROM learning_courses WHERE course_slug=? AND active=1", [courseSlug]);
  if (!course) throw new Error("Learning course not found.");
  await db.query(
    `INSERT INTO learning_entitlements (customer_id,course_slug,source,active) VALUES (?,?,?,1)
     ON DUPLICATE KEY UPDATE source=VALUES(source),active=1,expires_at=NULL,updated_at=NOW(3)`,
    [customer.id, courseSlug, process.env.ENTITLEMENT_SOURCE?.trim() || "manual"],
  );
  console.log(JSON.stringify({ granted: true, email, courseSlug }));
} finally {
  await db.end();
}

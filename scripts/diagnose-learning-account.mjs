import mysql from "mysql2/promise";

if (!process.env.MYSQL_URL || !process.env.CUSTOMER_EMAIL) throw new Error("MYSQL_URL and CUSTOMER_EMAIL are required.");
const db = await mysql.createConnection({ uri: process.env.MYSQL_URL });
try {
  const [rows] = await db.query(
    `SELECT c.id,c.email,COUNT(DISTINCT o.id) orders,
            COUNT(DISTINCT CASE WHEN i.course_slug='novo-cpa' AND (o.status='paid' OR o.paid_cents>0 OR o.access_granted_at IS NOT NULL) THEN o.id END) cpaOrders,
            COUNT(DISTINCT CASE WHEN e.course_slug='novo-cpa' AND e.status='confirmed' THEN e.id END) cpaEnrollments,
            COUNT(DISTINCT CASE WHEN le.course_slug='novo-cpa' AND le.active=1 AND (le.expires_at IS NULL OR le.expires_at>NOW(3)) THEN le.course_slug END) cpaEntitlements
     FROM customers c
     LEFT JOIN orders o ON o.customer_id=c.id
     LEFT JOIN order_items i ON i.order_id=o.id
     LEFT JOIN enrollments e ON e.customer_id=c.id
     LEFT JOIN learning_entitlements le ON le.customer_id=c.id
     WHERE c.email=? GROUP BY c.id,c.email`,
    [process.env.CUSTOMER_EMAIL.trim().toLowerCase()],
  );
  console.log(JSON.stringify(rows));
} finally {
  await db.end();
}

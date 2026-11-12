-- QluePrint sample queries (PostgreSQL) for the qlueprint_demo sample data.
-- Select one query and run it to see its result. Running the whole script shows only the last one.

-- All customers
SELECT id, first_name, last_name, email, city, country, created_at
FROM customers
ORDER BY id;

-- Orders with customer names
SELECT o.id, o.order_date, c.first_name, c.last_name, o.status, o.total_amount
FROM orders o
JOIN customers c ON c.id = o.customer_id
ORDER BY o.order_date DESC;

-- Total sales (cancelled orders don't count)
SELECT COUNT(*) AS orders, SUM(total_amount) AS total_sales
FROM orders
WHERE status <> 'cancelled';

-- Best sellers
SELECT p.name, p.category, SUM(i.quantity) AS units_sold, SUM(i.quantity * i.unit_price) AS revenue
FROM order_items i
JOIN products p ON p.id = i.product_id
JOIN orders o ON o.id = i.order_id
WHERE o.status <> 'cancelled'
GROUP BY p.id, p.name, p.category
ORDER BY units_sold DESC, revenue DESC
LIMIT 5;

-- Low stock (fewer than 10 left)
SELECT name, category, stock_quantity
FROM products
WHERE stock_quantity < 10
ORDER BY stock_quantity;

-- Revenue by month
SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month, SUM(total_amount) AS revenue
FROM orders
WHERE status <> 'cancelled'
GROUP BY to_char(date_trunc('month', order_date), 'YYYY-MM')
ORDER BY month;

-- Customers with no orders
SELECT c.id, c.first_name, c.last_name, c.email
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL
ORDER BY c.id;

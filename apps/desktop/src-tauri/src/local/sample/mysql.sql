-- QluePrint sample data (MySQL and MariaDB). Embedded in the app (src/local/sample.rs).
-- Idempotent: tables are created only if missing and rows are keyed by id, so running it again
-- changes nothing. The app refuses to run it when a table of the same name exists without the
-- QluePrint marker (a table comment), so a user's own tables are never touched.

CREATE TABLE IF NOT EXISTS customers (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    first_name varchar(50) NOT NULL,
    last_name varchar(50) NOT NULL,
    email varchar(255) NOT NULL UNIQUE,
    city varchar(80),
    country varchar(80),
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='QluePrint sample data';
CREATE TABLE IF NOT EXISTS products (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name varchar(120) NOT NULL,
    category varchar(50),
    price decimal(10, 2) NOT NULL CHECK (price >= 0),
    stock_quantity int NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX products_category_idx (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='QluePrint sample data';
CREATE TABLE IF NOT EXISTS orders (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer_id int NOT NULL,
    order_date datetime NOT NULL,
    status varchar(20) NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
    total_amount decimal(12, 2) NOT NULL,
    INDEX orders_customer_id_idx (customer_id),
    INDEX orders_order_date_idx (order_date),
    CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='QluePrint sample data';
CREATE TABLE IF NOT EXISTS order_items (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id int NOT NULL,
    product_id int NOT NULL,
    quantity int NOT NULL CHECK (quantity > 0),
    unit_price decimal(10, 2) NOT NULL,
    INDEX order_items_order_id_idx (order_id),
    INDEX order_items_product_id_idx (product_id),
    CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='QluePrint sample data';
CREATE TABLE IF NOT EXISTS employees (
    id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
    first_name varchar(50) NOT NULL,
    last_name varchar(50) NOT NULL,
    department varchar(50) NOT NULL,
    job_title varchar(80),
    salary decimal(10, 2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='QluePrint sample data';

INSERT IGNORE INTO customers (id, first_name, last_name, email, city, country, created_at) VALUES
    (1, 'Ana', 'Silva', 'ana.silva@example.com', 'Lisbon', 'Portugal', '2025-11-03 09:14:00'),
    (2, 'Liam', 'O''Connor', 'liam.oconnor@example.com', 'Dublin', 'Ireland', '2025-11-18 16:40:00'),
    (3, 'Mei', 'Tanaka', 'mei.tanaka@example.com', 'Osaka', 'Japan', '2025-12-02 03:05:00'),
    (4, 'Jonas', 'Weber', 'jonas.weber@example.com', 'Berlin', 'Germany', '2025-12-21 11:27:00'),
    (5, 'Priya', 'Nair', 'priya.nair@example.com', 'Bengaluru', 'India', '2026-01-09 07:52:00'),
    (6, 'Carlos', 'Mendoza', 'carlos.mendoza@example.com', NULL, 'Mexico', '2026-01-24 19:33:00'),
    (7, 'Sofia', 'Rossi', 'sofia.rossi@example.com', 'Milan', 'Italy', '2026-02-11 13:08:00'),
    (8, 'Ethan', 'Brooks', 'ethan.brooks@example.com', 'Austin', 'United States', '2026-02-27 22:15:00'),
    (9, 'Amara', 'Okafor', 'amara.okafor@example.com', 'Lagos', 'Nigeria', '2026-03-15 08:41:00'),
    (10, 'Lucas', 'Martin', 'lucas.martin@example.com', NULL, NULL, '2026-04-02 17:59:00');

INSERT IGNORE INTO products (id, name, category, price, stock_quantity, created_at) VALUES
    (1, 'Mechanical keyboard', 'Electronics', 89.00, 34, '2025-10-01 10:00:00'),
    (2, 'Wireless mouse', 'Electronics', 29.50, 120, '2025-10-01 10:00:00'),
    (3, '27-inch monitor', 'Electronics', 249.99, 8, '2025-10-15 10:00:00'),
    (4, 'Noise-cancelling headphones', 'Electronics', 179.00, 3, '2025-11-02 10:00:00'),
    (5, 'The Pragmatic Programmer', 'Books', 42.00, 57, '2025-10-01 10:00:00'),
    (6, 'Designing Data-Intensive Applications', 'Books', 48.50, 0, '2025-10-20 10:00:00'),
    (7, 'Standing desk', 'Office', 399.00, 5, '2025-11-10 10:00:00'),
    (8, 'Ergonomic chair', 'Office', 289.00, 12, '2025-11-10 10:00:00'),
    (9, 'Ceramic pour-over set', 'Home', 34.90, 64, '2025-12-01 10:00:00'),
    (10, 'Trail backpack 30L', NULL, 74.00, 22, '2026-01-05 10:00:00');

INSERT IGNORE INTO orders (id, customer_id, order_date, status, total_amount) VALUES
    (1, 1, '2026-01-04 10:12:00', 'delivered', 118.50),
    (2, 2, '2026-01-11 14:30:00', 'delivered', 84.00),
    (3, 3, '2026-01-19 09:45:00', 'delivered', 308.99),
    (4, 1, '2026-02-02 18:05:00', 'delivered', 83.40),
    (5, 4, '2026-02-14 12:00:00', 'cancelled', 399.00),
    (6, 5, '2026-02-22 08:20:00', 'delivered', 208.50),
    (7, 6, '2026-03-03 20:41:00', 'shipped', 378.00),
    (8, 2, '2026-03-17 11:11:00', 'delivered', 74.00),
    (9, 7, '2026-03-29 15:36:00', 'shipped', 90.50),
    (10, 8, '2026-04-06 09:02:00', 'paid', 588.98),
    (11, 3, '2026-04-18 13:47:00', 'paid', 69.80),
    (12, 5, '2026-05-01 07:30:00', 'shipped', 267.50),
    (13, 4, '2026-05-12 16:55:00', 'pending', 688.00),
    (14, 7, '2026-05-26 10:10:00', 'pending', 252.00),
    (15, 1, '2026-06-03 19:25:00', 'paid', 179.00);

INSERT IGNORE INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
    (1, 1, 1, 1, 89.00),
    (2, 1, 2, 1, 29.50),
    (3, 2, 5, 2, 42.00),
    (4, 3, 3, 1, 249.99),
    (5, 3, 2, 2, 29.50),
    (6, 4, 9, 1, 34.90),
    (7, 4, 6, 1, 48.50),
    (8, 5, 7, 1, 399.00),
    (9, 6, 4, 1, 179.00),
    (10, 6, 2, 1, 29.50),
    (11, 7, 8, 1, 289.00),
    (12, 7, 1, 1, 89.00),
    (13, 8, 10, 1, 74.00),
    (14, 9, 5, 1, 42.00),
    (15, 9, 6, 1, 48.50),
    (16, 10, 3, 2, 249.99),
    (17, 10, 1, 1, 89.00),
    (18, 11, 9, 2, 34.90),
    (19, 12, 2, 3, 29.50),
    (20, 12, 4, 1, 179.00),
    (21, 13, 7, 1, 399.00),
    (22, 13, 8, 1, 289.00),
    (23, 14, 1, 2, 89.00),
    (24, 14, 10, 1, 74.00),
    (25, 15, 4, 1, 179.00);

INSERT IGNORE INTO employees (id, first_name, last_name, department, job_title, salary) VALUES
    (1, 'Nora', 'Lindqvist', 'Engineering', 'Staff engineer', 142000.00),
    (2, 'Tomás', 'Herrera', 'Sales', 'Account executive', 86000.00),
    (3, 'Aisha', 'Rahman', 'Support', 'Support lead', 72000.00),
    (4, 'Daniel', 'Kim', 'Engineering', NULL, 98000.00),
    (5, 'Elena', 'Petrova', 'Finance', 'Controller', 115000.00);

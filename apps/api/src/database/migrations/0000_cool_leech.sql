CREATE TABLE `halls` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `restaurant_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`logo_path` text,
	`primary_color` text NOT NULL,
	`secondary_color` text NOT NULL,
	`currency_code` text DEFAULT 'DZD' NOT NULL,
	`tax_rate_percent` integer DEFAULT 0 NOT NULL,
	`default_language` text DEFAULT 'ar' NOT NULL,
	`setup_completed_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_restaurant_profile_language" CHECK("restaurant_profile"."default_language" IN ('ar','fr')),
	CONSTRAINT "chk_restaurant_profile_tax_rate" CHECK("restaurant_profile"."tax_rate_percent" >= 0)
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`email` text,
	`password_hash` text,
	`pin_hash` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_employees_role" CHECK("employees"."role" IN ('owner','manager','cashier','waiter','kitchen'))
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_invitations_status" CHECK("invitations"."status" IN ('pending','accepted','revoked','expired')),
	CONSTRAINT "chk_invitations_channel" CHECK("invitations"."channel" IN ('link','qr','email')),
	CONSTRAINT "chk_invitations_expiry_order" CHECK("invitations"."expires_at" > "invitations"."created_at")
);
--> statement-breakpoint
CREATE INDEX `idx_invitations_employee` ON `invitations` (`employee_id`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`device_label` text NOT NULL,
	`token_hash` text NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`permission_key` text NOT NULL,
	`allowed` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_role_permissions_role` ON `role_permissions` (`role`);--> statement-breakpoint
CREATE TABLE `table_bill_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_table_bill_groups_status" CHECK("table_bill_groups"."status" IN ('open','closed')),
	CONSTRAINT "chk_table_bill_groups_status_closed_at" CHECK(("table_bill_groups"."status" = 'open' AND "table_bill_groups"."closed_at" IS NULL) OR ("table_bill_groups"."status" = 'closed' AND "table_bill_groups"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_table_bill_groups_table_status` ON `table_bill_groups` (`table_id`,`status`);--> statement-breakpoint
CREATE TABLE `tables` (
	`id` text PRIMARY KEY NOT NULL,
	`hall_id` text NOT NULL,
	`label` text NOT NULL,
	`qr_token` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`hall_id`) REFERENCES `halls`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_tables_status" CHECK("tables"."status" IN ('available','occupied','bill_requested','needs_cleaning'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tables_qr_token` ON `tables` (`qr_token`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name_ar` text NOT NULL,
	`name_fr` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text,
	`name_ar` text NOT NULL,
	`name_fr` text NOT NULL,
	`price_minor` integer NOT NULL,
	`image_path` text,
	`is_available` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_products_price" CHECK("products"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`name_snapshot` text NOT NULL,
	`category_snapshot` text NOT NULL,
	`unit_price_minor_snapshot` integer NOT NULL,
	`quantity` integer NOT NULL,
	`notes` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_order_items_quantity" CHECK("order_items"."quantity" > 0),
	CONSTRAINT "chk_order_items_price" CHECK("order_items"."unit_price_minor_snapshot" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_order_items_order` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_employee_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_order_status_events_order` ON `order_status_events` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`table_bill_group_id` text NOT NULL,
	`table_id` text NOT NULL,
	`channel` text DEFAULT 'dine_in' NOT NULL,
	`is_addon` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text NOT NULL,
	`created_by_employee_id` text,
	`accepted_by_employee_id` text,
	`served_by_employee_id` text,
	`cancelled_by_employee_id` text,
	`cancellation_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`table_bill_group_id`) REFERENCES `table_bill_groups`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_orders_channel" CHECK("orders"."channel" IN ('dine_in','delivery')),
	CONSTRAINT "chk_orders_source" CHECK("orders"."source" IN ('qr','waiter_manual')),
	CONSTRAINT "chk_orders_status" CHECK("orders"."status" IN ('pending','accepted','preparing','ready','served','paid','completed','cancelled')),
	CONSTRAINT "chk_orders_cancellation_reason" CHECK(("orders"."status" = 'cancelled' AND "orders"."cancellation_reason" IS NOT NULL) OR "orders"."status" != 'cancelled')
);
--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `idx_orders_bill_group` ON `orders` (`table_bill_group_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_table_status` ON `orders` (`table_id`,`status`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`table_bill_group_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`method` text DEFAULT 'cash' NOT NULL,
	`collected_by_employee_id` text NOT NULL,
	`shift_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`table_bill_group_id`) REFERENCES `table_bill_groups`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collected_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_payments_amount" CHECK("payments"."amount_minor" > 0),
	CONSTRAINT "chk_payments_method" CHECK("payments"."method" IN ('cash'))
);
--> statement-breakpoint
CREATE INDEX `idx_payments_bill_group` ON `payments` (`table_bill_group_id`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`opening_cash_minor` integer NOT NULL,
	`closing_cash_minor` integer,
	`expected_cash_minor` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_shifts_status" CHECK("shifts"."status" IN ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_employee_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`old_value_json` text,
	`new_value_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_created_at` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_role` text,
	`recipient_employee_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`recipient_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_recipient` ON `notifications` (`recipient_employee_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `product_sales_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`product_name_snapshot` text NOT NULL,
	`category_snapshot` text NOT NULL,
	`quantity_sold` integer DEFAULT 0 NOT NULL,
	`revenue_minor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_product_sales_rollup_date` ON `product_sales_rollup` (`date`);--> statement-breakpoint
CREATE TABLE `sales_rollup_daily` (
	`date` text PRIMARY KEY NOT NULL,
	`total_revenue_minor` integer DEFAULT 0 NOT NULL,
	`dine_in_revenue_minor` integer DEFAULT 0 NOT NULL,
	`delivery_revenue_minor` integer DEFAULT 0 NOT NULL,
	`total_orders` integer DEFAULT 0 NOT NULL,
	`cancelled_orders` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sales_rollup_hourly` (
	`date` text NOT NULL,
	`hour` integer NOT NULL,
	`revenue_minor` integer DEFAULT 0 NOT NULL,
	`orders_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `hour`)
);
--> statement-breakpoint
CREATE INDEX `idx_sales_rollup_hourly_date` ON `sales_rollup_hourly` (`date`);--> statement-breakpoint
CREATE TABLE `backup_history` (
	`id` text PRIMARY KEY NOT NULL,
	`file_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_backup_history_status" CHECK("backup_history"."status" IN ('success','failed')),
	CONSTRAINT "chk_backup_history_trigger" CHECK("backup_history"."trigger" IN ('automatic','manual','pre_migration'))
);

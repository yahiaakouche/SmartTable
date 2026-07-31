CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_idempotency_keys_key_endpoint` ON `idempotency_keys` (`key`,`endpoint`);
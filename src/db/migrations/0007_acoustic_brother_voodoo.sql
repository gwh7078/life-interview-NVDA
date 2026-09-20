CREATE TABLE `memoir_book_items` (
	`book_item_id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`story_id` text NOT NULL,
	`document_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`included` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `memoir_books`(`book_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`story_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`document_id`) REFERENCES `memoir_documents`(`document_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memoir_book_items_book_story_uq` ON `memoir_book_items` (`book_id`,`story_id`);--> statement-breakpoint
CREATE INDEX `memoir_book_items_book_order_idx` ON `memoir_book_items` (`book_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `memoir_book_items_story_idx` ON `memoir_book_items` (`story_id`);--> statement-breakpoint
CREATE INDEX `memoir_book_items_document_idx` ON `memoir_book_items` (`document_id`);--> statement-breakpoint
CREATE TABLE `memoir_books` (
	`book_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`author_name` text NOT NULL,
	`cover_config_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memoir_books_user_id_idx` ON `memoir_books` (`user_id`);--> statement-breakpoint
CREATE INDEX `memoir_books_user_updated_idx` ON `memoir_books` (`user_id`,`updated_at`);

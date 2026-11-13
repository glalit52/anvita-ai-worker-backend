ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "auth_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "amr" text DEFAULT 'pwd' NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_pending_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "refresh_tokens" USING btree ("session_id");
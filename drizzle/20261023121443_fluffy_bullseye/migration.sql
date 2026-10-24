CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"idempotency_key" text NOT NULL UNIQUE,
	"request_hash" text NOT NULL,
	"sender_id" uuid NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"html" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_email_kind_version_unique" UNIQUE("email_id","kind","version")
);
--> statement-breakpoint
CREATE TABLE "senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "emails_created_at_id_idx" ON "emails" ("created_at","id");--> statement-breakpoint
CREATE INDEX "emails_status_scheduled_at_idx" ON "emails" ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "emails_sender_id_idx" ON "emails" ("sender_id");--> statement-breakpoint
CREATE INDEX "outbox_available_at_idx" ON "outbox" ("available_at");--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_sender_id_senders_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "senders"("id");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_email_id_emails_id_fkey" FOREIGN KEY ("email_id") REFERENCES "emails"("id");
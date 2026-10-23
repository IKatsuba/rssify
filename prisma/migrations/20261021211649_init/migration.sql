-- CreateEnum
CREATE TYPE "FeedStatus" AS ENUM ('ok', 'failing', 'gone');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apikey" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "referenceId" TEXT NOT NULL,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" TIMESTAMP(3),
    "enabled" BOOLEAN DEFAULT true,
    "rateLimitEnabled" BOOLEAN DEFAULT true,
    "rateLimitTimeWindow" INTEGER DEFAULT 60000,
    "rateLimitMax" INTEGER DEFAULT 120,
    "requestCount" INTEGER DEFAULT 0,
    "remaining" INTEGER,
    "lastRequest" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT,

    CONSTRAINT "apikey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feed" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "pluginId" TEXT,
    "title" TEXT,
    "siteUrl" TEXT,
    "status" "FeedStatus" NOT NULL DEFAULT 'ok',
    "nextFetchAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "lastFetchedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "etag" TEXT,
    "lastModified" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entry" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "url" TEXT,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "summary" TEXT,
    "contentHtml" TEXT,
    "publishedAt" TIMESTAMP(3),
    "sortAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadMark" (
    "userId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadMark_pkey" PRIMARY KEY ("userId","entryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "apikey_configId_idx" ON "apikey"("configId");

-- CreateIndex
CREATE INDEX "apikey_referenceId_idx" ON "apikey"("referenceId");

-- CreateIndex
CREATE INDEX "apikey_key_idx" ON "apikey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Feed_url_key" ON "Feed"("url");

-- CreateIndex
CREATE INDEX "Feed_nextFetchAt_idx" ON "Feed"("nextFetchAt");

-- CreateIndex
CREATE INDEX "Entry_feedId_sortAt_id_idx" ON "Entry"("feedId", "sortAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Entry_sortAt_id_idx" ON "Entry"("sortAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Entry_feedId_guid_key" ON "Entry"("feedId", "guid");

-- CreateIndex
CREATE INDEX "Subscription_feedId_idx" ON "Subscription"("feedId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_feedId_key" ON "Subscription"("userId", "feedId");

-- CreateIndex
CREATE INDEX "ReadMark_entryId_idx" ON "ReadMark"("entryId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadMark" ADD CONSTRAINT "ReadMark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadMark" ADD CONSTRAINT "ReadMark_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

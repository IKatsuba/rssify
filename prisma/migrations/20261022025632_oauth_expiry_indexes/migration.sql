-- CreateIndex
CREATE INDEX "oauthAccessToken_expiresAt_idx" ON "oauthAccessToken"("expiresAt");

-- CreateIndex
CREATE INDEX "oauthClientAssertion_expiresAt_idx" ON "oauthClientAssertion"("expiresAt");

-- CreateIndex
CREATE INDEX "oauthRefreshToken_expiresAt_idx" ON "oauthRefreshToken"("expiresAt");

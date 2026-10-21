"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { auth } from "@/lib/auth"

export async function signOut() {
  const requestHeaders = await headers()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (session) await auth.api.signOut({ headers: requestHeaders })
  redirect("/sign-in")
}

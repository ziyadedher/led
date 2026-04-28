## Vercel project hosting the dash, imported from the existing manually-created
## project so we don't churn the public domain (`led.ziyadedher.com`) or break
## the GitHub link.
##
## Note: this is the only Vercel project across the user's account that lives
## in TF; the rest (ziyadedher, catears, webdev-template, …) are still
## manually configured in Vercel's UI.

import {
  to = vercel_project.led_dash
  id = "prj_S9rKfKQUr2h8OFvH7WcNR2cLkIOH"
}

resource "vercel_project" "led_dash" {
  name           = "led"
  framework      = "nextjs"
  root_directory = "dash"
  node_version   = "18.x"

  git_repository = {
    type              = "github"
    repo              = "ziyadedher/led"
    production_branch = "main"
  }
}

## Env vars driving the dash. SUPABASE_URL + SUPABASE_ANON_KEY come straight
## from the supabase TF outputs, so changing the Supabase project is
## propagated by `tofu apply` rather than manual re-paste.
##
## Marked `sensitive` for production + preview only; `development` (i.e. the
## `vercel dev` local flow) is intentionally non-sensitive so values appear
## in pulled `.env.development.local` files.

resource "vercel_project_environment_variable" "supabase_url_runtime" {
  project_id = vercel_project.led_dash.id
  key        = "SUPABASE_URL"
  value      = "https://${supabase_project.led.id}.supabase.co"
  target     = ["production", "preview"]
  sensitive  = false
}

resource "vercel_project_environment_variable" "supabase_anon_key_runtime" {
  project_id = vercel_project.led_dash.id
  key        = "SUPABASE_ANON_KEY"
  value      = data.supabase_apikeys.led.anon_key
  target     = ["production", "preview"]
  sensitive  = true
}

resource "vercel_project_environment_variable" "next_public_supabase_url" {
  project_id = vercel_project.led_dash.id
  key        = "NEXT_PUBLIC_SUPABASE_URL"
  value      = "https://${supabase_project.led.id}.supabase.co"
  target     = ["production", "preview", "development"]
  sensitive  = false
}

resource "vercel_project_environment_variable" "next_public_supabase_anon_key" {
  project_id = vercel_project.led_dash.id
  key        = "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  value      = data.supabase_apikeys.led.anon_key
  target     = ["production", "preview", "development"]
  sensitive  = false
}

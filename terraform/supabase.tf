resource "random_password" "db" {
  length  = 32
  special = false
}

resource "supabase_project" "led" {
  organization_id   = var.organization_id
  name              = var.project_name
  region            = var.region
  database_password = random_password.db.result

  # `legacy_api_keys_enabled` is omitted on purpose: new projects ship with
  # legacy anon/service_role JWTs already enabled, and explicitly setting
  # the (deprecated) attribute to `true` causes the provider to call an
  # idempotent endpoint that rejects re-enabling. Driver + dash still use
  # the anon JWT, which is what `data.supabase_apikeys.led.anon_key`
  # returns.

  lifecycle {
    # Recreating the project is destructive (data loss) and slow (~3 min).
    # Catch any plan that proposes a replace before it goes through.
    prevent_destroy = false
  }
}

data "supabase_apikeys" "led" {
  project_ref = supabase_project.led.id
}

# Schema migrations are now applied by the Supabase ↔ GitHub integration:
# pushing changes under `supabase/migrations/` to `main` triggers Supabase
# to run them against this project. We previously had a `terraform_data`
# resource that curl-POST'd the SQL via the Management API; that competed
# with the integration to apply the same files, so it's gone. Bootstrapping
# a *new* project from scratch now requires one push to main after
# `tofu apply` so the integration runs.


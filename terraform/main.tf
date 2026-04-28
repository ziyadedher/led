terraform {
  required_version = ">= 1.11"

  # State + plan files are encrypted at rest with AES-GCM. Key derived via
  # PBKDF2 from the passphrase in TF_VAR_tf_state_passphrase, which comes
  # from secrets.sops.json. Without the passphrase, `tofu init` / `apply`
  # fail; the encrypted state is safe to commit.
  encryption {
    key_provider "pbkdf2" "default" {
      passphrase = var.tf_state_passphrase
    }
    method "aes_gcm" "default" {
      keys = key_provider.pbkdf2.default
    }
    state {
      method = method.aes_gcm.default
    }
    plan {
      method = method.aes_gcm.default
    }
  }

  required_providers {
    sops = {
      source  = "carlpett/sops"
      version = "~> 1.0"
    }
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.9"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

data "sops_file" "secrets" {
  source_file = "${path.root}/../secrets.sops.json"
}

provider "supabase" {
  access_token = data.sops_file.secrets.data["SUPABASE_ACCESS_TOKEN"]
}

# `team` accepts either the team slug or the team id; using the slug here
# avoids hardcoding the opaque `team_…` id in source. All Vercel resources
# inherit this scope.
provider "vercel" {
  api_token = data.sops_file.secrets.data["VERCEL_API_TOKEN"]
  team      = "ziyadedher"
}

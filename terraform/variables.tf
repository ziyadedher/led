variable "organization_id" {
  description = "Supabase organization slug. Default is the personal `Ziyad Edher` org."
  type        = string
  default     = "nryncdukzhdafwxscnet"
}

variable "project_name" {
  description = "Supabase project name."
  type        = string
  default     = "led"
}

variable "region" {
  description = "Supabase region."
  type        = string
  default     = "us-west-1"
}

## NOTE: `instance_size` is intentionally absent. The free-plan API rejects
## any explicit instance_size (HTTP 402). Add it back here when (if) we move
## to a paid plan and want to pin the size.

variable "tf_state_passphrase" {
  description = "PBKDF2 passphrase used to encrypt state-at-rest. Set via TF_VAR_tf_state_passphrase, sourced from secrets.sops.json. Justfile recipes wrap tofu invocations to inject it."
  type        = string
  sensitive   = true
}

output "project_ref" {
  description = "Supabase project reference id (subdomain)."
  value       = supabase_project.led.id
}

output "supabase_url" {
  description = "Supabase base URL. Driver appends /rest/v1 for PostgREST; dash uses it directly with @supabase/supabase-js."
  value       = "https://${supabase_project.led.id}.supabase.co"
}

output "anon_key" {
  description = "Legacy anon JWT, used by the driver and the dash."
  value       = data.supabase_apikeys.led.anon_key
  sensitive   = true
}

output "service_role_key" {
  description = "Service-role JWT (admin). Don't bake into deployed binaries."
  value       = data.supabase_apikeys.led.service_role_key
  sensitive   = true
}

output "db_password" {
  description = "Postgres database password (for direct psql access via the connection string)."
  value       = random_password.db.result
  sensitive   = true
}

output "vercel_project_id" {
  description = "Vercel project id for the dash."
  value       = vercel_project.led_dash.id
}

output "vercel_project_name" {
  description = "Vercel project name (always `led`)."
  value       = vercel_project.led_dash.name
}

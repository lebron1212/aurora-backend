# Supabase Setup for Aurora Horizon Storage

## 1. Install Supabase CLI

```bash
npm install -g supabase
```

## 2. Create Supabase Project

```bash
# Login to Supabase
supabase login

# Initialize project in backend-deployment directory
cd backend-deployment
supabase init

# Create new project (run this command and follow prompts)
supabase projects create aurora-horizon-storage --region us-east-1
```

## 3. Get Connection Details

After project creation, get these environment variables:

```bash
# Get project URL and keys
supabase projects api-keys --project-ref YOUR_PROJECT_REF
```

## 4. Add to Railway Environment Variables

In Railway dashboard, add these environment variables:

```
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

## 5. Create Storage Bucket

```bash
# Create SQL migration for storage bucket
supabase gen migration create_horizon_storage
```

Add this SQL to the migration file:

```sql
-- Create storage bucket for Horizon files
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('horizon-files', 'horizon-files', false, 52428800, ARRAY['application/json', 'text/plain']);

-- Create policy to allow authenticated access
CREATE POLICY "Allow authenticated access to horizon files"
ON storage.objects FOR ALL
USING (bucket_id = 'horizon-files');
```

## 6. Run Migration

```bash
supabase db push
```

## 7. Test Connection

```bash
# Test with a simple file upload
curl -X POST 'https://YOUR_PROJECT_REF.supabase.co/storage/v1/object/horizon-files/test.json' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

## Next Steps

After setup is complete:
1. Update backend-deployment/package.json with @supabase/supabase-js
2. Create horizon-crs-service.js with Supabase integration
3. Update task-notification-server.js to use the new service
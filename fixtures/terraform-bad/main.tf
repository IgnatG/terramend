# Deliberately non-best-practice Terraform for dogfooding the Remediator.
# Expected concerns: unencrypted + public S3 bucket (tfsec/checkov), an unused
# variable + missing required_providers (tflint), and non-canonical formatting
# (terraform fmt — note the over-indented `bucket` and misaligned `=` below).

resource "aws_s3_bucket" "data" {
    bucket = "example-remediator-fixture"
  acl   = "public-read"
}

variable "unused" {
  type    = string
  default = "not used anywhere"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

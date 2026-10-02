# ==================================================================
#  COST-1: IMAGE STORAGE -- THE EXISTING ECR REPOSITORY, WITH A LIFECYCLE POLICY
# ==================================================================
#
# ECR is kept (COST-1 Part 12): the host pulls with its instance role through the amazon-ecr-credential-helper, so no
# registry password or token is ever stored on the host. A release image is ~0.1 GB compressed: `ecr_keep_images` (20)
# releases cost ~$0.20/month at $0.10/GB-month, and the same-region pull is free. Tags stay IMMUTABLE (stacks/app).
# The repository itself stays in stacks/app; only its lifecycle policy is attached here.

resource "aws_ecr_lifecycle_policy" "server" {
  count      = var.manage_ecr_lifecycle ? 1 : 0
  repository = local.ecr_repository_name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Untagged layers/manifests (failed or superseded pushes) after 7 days"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the newest ${var.ecr_keep_images} images (rollback history)"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.ecr_keep_images }
        action       = { type = "expire" }
      },
    ]
  })
}

# ==================================================================
#  LIVE-5 L5-8: THE HARD EDGE REQUIREMENT -- /gs* QUERY STRINGS FORWARDED UNCHANGED (cp, cr, cb), UNCACHED
# ==================================================================
#
# LIVE-4 / L5-7 §14: a current client announces its protocol in the WebSocket URL's query (`cp`, `cr`, `cb`). An edge that
# drops or narrows the query makes it read as a legacy protocol-0 client -- a CORRECTNESS failure, not tuning. So the /gs*
# behaviour forwards:
#   query strings  ALL of them (`query_string_behavior = "all"`) -- never an allow-list, which would silently drop the next
#                  protocol field a later client adds;
#   cookies        ALL (the session cookie, bootstrapped at POST /gs/api/session);
#   headers        Origin (the server's origin check) and the WebSocket handshake headers CloudFront documents
#                  (Sec-WebSocket-Key, -Version, -Protocol, -Accept, -Extensions); CloudFront carries the Upgrade itself;
#   caching        disabled (the managed CachingDisabled policy), every method allowed.
# The same policy objects are what `awsDeploy verify` checks on the live distribution (the evidence files, README).

# AWS's managed cache policies, by their published ids (the same in every account; `awsDeploy verify` compares the live
# /gs* behaviour's id with CACHING_DISABLED_POLICY_ID).
locals {
  caching_disabled_policy_id  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  caching_optimized_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
}

resource "aws_cloudfront_origin_request_policy" "gs" {
  name    = "${local.prefix}-gs-all-query-cookies-origin"
  comment = "18Cosmos ${var.environment} /gs*: ALL query strings unchanged (cp, cr, cb), all cookies, Origin + WebSocket headers"

  query_strings_config {
    query_string_behavior = "all"
  }

  cookies_config {
    cookie_behavior = "all"
  }

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Accept", "Sec-WebSocket-Extensions"]
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  count = var.edge.create_distribution ? 1 : 0

  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3" # a WebSocket upgrade still runs over HTTP/1.1 (CloudFront's only WebSocket protocol)
  price_class     = var.edge.price_class
  aliases         = var.edge.aliases
  comment         = "18Cosmos ${var.environment}: the site and /gs* (the game server)"

  origin {
    origin_id   = "site"
    domain_name = var.edge.site_origin_domain_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    origin_id   = "gs-alb"
    domain_name = var.edge.alb_origin_domain_name
    # Pinned, not left to the provider: hashicorp/aws 6.66.0 made this Optional+Computed, so omitting it leaves a
    # replaced origin-set element (the edge cutover changes domain_name) unknown until apply and the cutover guard
    # refuses the plan. 0 = no maximum (the provider never sends 0 to CloudFront; the live value reads back as 0).
    response_completion_timeout = 0
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = var.edge.origin_read_timeout
      origin_keepalive_timeout = 5
    }
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_optimized_policy_id
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern             = "/gs*"
    target_origin_id         = "gs-alb"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.caching_disabled_policy_id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.gs.id
    compress                 = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.edge.viewer_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.tags
}

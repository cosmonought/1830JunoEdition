#!/usr/bin/env python3
# STEP 9 ACME HOTFIX reproduction ONLY (never production): a minimal local stand-in for the two APIs moto 5.2.3 cannot
# serve to hashicorp/aws 6.66.0 -- CloudWatch (the provider speaks Smithy RPCv2-CBOR; moto answers the Query/XML protocol:
# "unexpected minor value 28") and AWS Budgets (moto lacks DescribeSubscribersForNotification, so the provider waits
# forever). It STORES what the provider puts and ECHOES it back on read; it judges nothing. Everything else (EC2, IAM,
# Logs, STS) is moto. Listens on 127.0.0.1:5001.
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cbor2

ACCOUNT = "123456789012"
REGION = "us-east-1"
ALARMS = {}
ALARM_TAGS = {}
BUDGETS = {}
NOTIFICATIONS = {}
BUDGET_TAGS = {}


def cloudwatch(op, req):
    if op == "PutMetricAlarm":
        alarm = dict(req)
        tags = alarm.pop("Tags", None) or []
        alarm["AlarmArn"] = f"arn:aws:cloudwatch:{REGION}:{ACCOUNT}:alarm:{alarm['AlarmName']}"
        alarm.setdefault("ActionsEnabled", True)
        alarm.setdefault("StateValue", "INSUFFICIENT_DATA")
        ALARMS[alarm["AlarmName"]] = alarm
        ALARM_TAGS[alarm["AlarmArn"]] = tags
        return {}
    if op == "DescribeAlarms":
        names = req.get("AlarmNames") or list(ALARMS)
        return {"MetricAlarms": [ALARMS[n] for n in names if n in ALARMS], "CompositeAlarms": []}
    if op == "ListTagsForResource":
        return {"Tags": ALARM_TAGS.get(req.get("ResourceARN"), [])}
    if op == "TagResource":
        ALARM_TAGS.setdefault(req["ResourceARN"], []).extend(req.get("Tags", []))
        return {}
    if op == "DeleteAlarms":
        for n in req.get("AlarmNames", []):
            ALARMS.pop(n, None)
        return {}
    raise KeyError(op)


def budgets(op, req):
    if op == "CreateBudget":
        b = dict(req["Budget"])
        b.setdefault("CalculatedSpend", {"ActualSpend": {"Amount": "0", "Unit": "USD"}})
        BUDGETS[b["BudgetName"]] = b
        NOTIFICATIONS[b["BudgetName"]] = req.get("NotificationsWithSubscribers", [])
        BUDGET_TAGS[f"arn:aws:budgets::{ACCOUNT}:budget/{b['BudgetName']}"] = req.get("ResourceTags", [])
        return {}
    if op == "CreateNotification":
        NOTIFICATIONS.setdefault(req["BudgetName"], []).append({"Notification": req["Notification"], "Subscribers": req.get("Subscribers", [])})
        return {}
    if op == "DescribeBudget":
        b = BUDGETS.get(req["BudgetName"])
        if b is None:
            return ("NotFoundException", "budget not found")
        return {"Budget": b}
    if op == "DescribeNotificationsForBudget":
        return {"Notifications": [n["Notification"] for n in NOTIFICATIONS.get(req["BudgetName"], [])]}
    if op == "DescribeSubscribersForNotification":
        for n in NOTIFICATIONS.get(req["BudgetName"], []):
            if n["Notification"] == req["Notification"]:
                return {"Subscribers": n["Subscribers"]}
        return {"Subscribers": []}
    if op == "DescribeBudgetActionsForBudget":
        return {"Actions": []}
    if op == "ListTagsForResource":
        return {"ResourceTags": BUDGET_TAGS.get(req.get("ResourceARN"), [])}
    if op == "TagResource":
        BUDGET_TAGS.setdefault(req["ResourceARN"], []).extend(req.get("ResourceTags", []))
        return {}
    raise KeyError(op)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("fake: " + (fmt % args) + "\n")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
        if "/operation/" in self.path:  # Smithy RPCv2-CBOR (CloudWatch)
            op = self.path.rsplit("/", 1)[1]
            req = cbor2.loads(body) if body else {}
            try:
                out = cloudwatch(op, req)
                code = 200
            except KeyError:
                out, code = {"__type": "InvalidAction", "message": op}, 400
            sys.stderr.write(f"fake: cloudwatch {op} -> {code}\n")
            data = cbor2.dumps(out)
            self.send_response(code)
            self.send_header("Content-Type", "application/cbor")
            self.send_header("smithy-protocol", "rpc-v2-cbor")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        target = self.headers.get("X-Amz-Target", "")
        op = target.split(".", 1)[1] if "." in target else ""
        req = json.loads(body or b"{}")
        try:
            out = budgets(op, req)
        except KeyError:
            out = ("InvalidAction", op)
        sys.stderr.write(f"fake: budgets {op} -> {'ERROR ' + str(out) if isinstance(out, tuple) else 'ok'}\n")
        if isinstance(out, tuple):
            data = json.dumps({"__type": out[0], "Message": out[1]}).encode()
            self.send_response(400)
        else:
            data = json.dumps(out).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/x-amz-json-1.1")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 5001), Handler).serve_forever()

"""移动公众真实进入的登录登记回归测试；不访问平台。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app" / "ecloud_engine"))
import sidecar
from ecloud_client import EcloudError


class FakeHttp:
    def __init__(self, connect_errors=()):
        self.calls = []
        self.connect_errors = list(connect_errors)

    def post(self, endpoint, payload=None):
        self.calls.append((endpoint, payload))
        if endpoint == sidecar._config.Endpoint.GET_DEVICE_INFO:
            return {"machineList": [{
                "instanceId": "instance-1", "machineId": "machine-1",
                "machineName": "测试电脑", "originCompanyCode": "CMSSZTE",
                "resourceStatus": "available",
            }]}
        if endpoint == sidecar._config.Endpoint.SESSION_MACHINE_CONNECT:
            if self.connect_errors:
                raise self.connect_errors.pop(0)
            return {"connectId": "confirmed"}
        return {}


class SessionRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.http = FakeHttp()
        self.session = {
            "http": self.http, "accessTicket": "test-ticket", "loginUid": "login-1",
            "loginRecorded": True,
        }
        self.patches = [
            patch.object(sidecar, "_require_ready"),
            patch.object(sidecar, "_session", return_value=self.session),
            patch.object(sidecar.login_mod, "get_user_info", return_value={"userInfoList": [{}]}),
            patch.object(sidecar.time, "sleep"),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_refreshes_login_record_for_each_connection(self):
        for _ in range(2):
            sidecar.op_desktop_connect_info({"sessionId": "account-1", "instanceId": "instance-1"})
        records = [payload for endpoint, payload in self.http.calls
                   if endpoint == sidecar._config.Endpoint.RECORD_DEVICE_INFO]
        self.assertEqual(records, [{"clientLoginUid": "login-1"}] * 2)

    def test_missing_record_is_registered_and_retried_once(self):
        self.http.connect_errors = [EcloudError({
            "errorCode": 500,
            "errorMessage": "没有找到桌面连接客户端登录的信息 ticket=secret-value",
        })]
        result = sidecar.op_desktop_report_connect({
            "sessionId": "account-1", "machineId": "machine-1", "connectId": "connect-1",
        })
        self.assertEqual(result["connectId"], "confirmed")
        endpoints = [endpoint for endpoint, _ in self.http.calls]
        self.assertEqual(endpoints, [
            sidecar._config.Endpoint.SESSION_MACHINE_CONNECT,
            sidecar._config.Endpoint.RECORD_DEVICE_INFO,
            sidecar._config.Endpoint.SESSION_MACHINE_CONNECT,
        ])

    def test_unconfirmed_response_never_leaks_ticket(self):
        error = EcloudError({
            "errorCode": 500,
            "errorMessage": "没有找到桌面连接客户端登录的信息 ticket=secret-value",
        })
        self.http.connect_errors = [error, error]
        with self.assertRaisesRegex(RuntimeError, "平台未找到本机登录登记") as caught:
            sidecar.op_desktop_report_connect({
                "sessionId": "account-1", "machineId": "machine-1", "connectId": "connect-1",
            })
        self.assertNotIn("secret-value", str(caught.exception))
        self.assertEqual(sum(endpoint == sidecar._config.Endpoint.SESSION_MACHINE_CONNECT
                             for endpoint, _ in self.http.calls), 2)

    def test_other_platform_error_does_not_retry(self):
        self.http.connect_errors = [EcloudError({
            "errorCode": 401, "errorMessage": "token失效 ticket=secret-value",
        })]
        with self.assertRaisesRegex(RuntimeError, "平台错误码 401") as caught:
            sidecar.op_desktop_report_connect({
                "sessionId": "account-1", "machineId": "machine-1", "connectId": "connect-1",
            })
        self.assertNotIn("secret-value", str(caught.exception))
        self.assertEqual(len(self.http.calls), 1)


if __name__ == "__main__":
    unittest.main()

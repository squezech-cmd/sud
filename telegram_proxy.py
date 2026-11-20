#!/usr/bin/env python3
"""Запустить локальный SOCKS5-прокси через собственный SSH-сервер."""

import argparse
import re
import shutil
import subprocess
import sys


def port(value):
    try:
        number = int(value)
        if 1 <= number <= 65535:
            return number
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("порт должен быть числом от 1 до 65535")


def main():
    parser = argparse.ArgumentParser(
        description="Локальный SOCKS5-прокси для Telegram через ваш SSH-сервер"
    )
    parser.add_argument("server", help="IP-адрес или доменное имя SSH-сервера")
    parser.add_argument("user", help="имя пользователя на SSH-сервере")
    parser.add_argument("--ssh-port", type=port, default=22, help="порт SSH (по умолчанию 22)")
    parser.add_argument("--local-port", type=port, default=1080, help="локальный порт SOCKS5 (по умолчанию 1080)")
    args = parser.parse_args()

    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", args.server):
        parser.error("укажите IPv4-адрес или доменное имя сервера")
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_.-]*", args.user):
        parser.error("недопустимое имя пользователя")
    ssh = shutil.which("ssh")
    if not ssh:
        parser.error("не найден ssh: установите OpenSSH Client в дополнительных компонентах Windows")

    command = [
        ssh, "-N", "-D", f"127.0.0.1:{args.local_port}",
        "-p", str(args.ssh_port), "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
        f"{args.user}@{args.server}",
    ]
    print(f"В Telegram укажите SOCKS5: 127.0.0.1:{args.local_port} без логина и пароля.", flush=True)
    print("При первом подключении сверьте отпечаток ключа сервера по доверенному каналу.", flush=True)
    print("Оставьте это окно открытым. Для остановки нажмите Ctrl+C.", flush=True)
    try:
        return subprocess.call(command)
    except KeyboardInterrupt:
        print("\nПрокси остановлен.")
        return 130
    except OSError as error:
        print(f"Не удалось запустить SSH: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

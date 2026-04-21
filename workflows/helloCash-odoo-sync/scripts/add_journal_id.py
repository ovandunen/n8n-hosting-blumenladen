import os
import xmlrpc.client

url = "http://localhost:8069"
db = "blumenladen"
uid = 2  # dein ODOO_UID
password = os.environ["ODOO_PASSWORD"]

models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")

journal_id = models.execute_kw(db, uid, password,
    'account.journal', 'create', [{
        'name': 'Kasse Blumenladen',
        'type': 'cash',
        'code': 'kios',
        'currency_id': False,  # EUR als Standardwährung
    }]
)

print(f"Neues Journal angelegt mit ID: {journal_id}")

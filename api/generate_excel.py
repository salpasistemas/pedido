import os
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
import io
import json

app = FastAPI()

@app.post("/api/generate_excel")
async def generate_excel(request: Request):
    data = await request.json()
    products = data.get("products", [])
    template_path = os.path.join(os.path.dirname(__file__), "../templates/peddo_template.xlsx")
    
    wb = load_workbook(template_path)
    ws = wb['PEDIDO']  # Nombre exacto de la hoja

    # Limpiamos filas viejas (opcional: solo si querés limpiar siempre antes)
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row):
        for cell in row:
            cell.value = None

    # INSERTAR DATOS desde la fila 2 (ajusta el orden de columnas según tu template)
    for idx, prod in enumerate(products, start=2):
        ws[f"A{idx}"] = 1  # Cliente ID
        ws[f"B{idx}"] = prod['product_id']
        ws[f"C{idx}"] = ""  # Cantidad vacía
        ws[f"D{idx}"] = round(prod['price'] * 0.4, 2)  # Precio con 60% descuento
        # Si tu template tiene más columnas, agregalas aquí
        # ws[f"E{idx}"] = prod['display_name']   # Si tenés una columna producto
        # ws[f"F{idx}"] = prod['qty_available']  # Si tenés una columna stock

    # Guardar en memoria y devolver
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=pedido_stock.xlsx"}
    )

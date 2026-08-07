"""Stromkreis data pipeline: EEG-Faktura import, weather import, forecast runs.

Planned modules (ported from the ISCHLSTROM reference implementation):

- eegfaktura: energy report loader (export files + API), partial-delivery detection
- weather: Open-Meteo archive/forecast import per tenant location
- forecast: versioned forecast runs per tenant
"""

__version__ = "0.1.0"

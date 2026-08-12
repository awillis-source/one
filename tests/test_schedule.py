"""Installment due dates, and schedules that add up to the contract."""

from datetime import date
from decimal import Decimal

import pytest

from tmg_quotes.finance import (
    add_months,
    final_installment,
    installment_dates,
    payment_quote,
)
from tmg_quotes.models import Financing, FinancingPlan


def test_add_months_keeps_the_day_of_month():
    assert add_months(date(2026, 8, 11), 1) == date(2026, 9, 11)
    assert add_months(date(2026, 8, 11), 12) == date(2027, 8, 11)


def test_add_months_clamps_to_a_shorter_month():
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)  # leap year


def test_installments_start_a_month_after_signing():
    dates = installment_dates(date(2026, 8, 11), 12)
    assert len(dates) == 12
    assert dates[0] == date(2026, 9, 11)
    assert dates[-1] == date(2027, 8, 11)


def test_final_installment_clears_a_zero_apr_balance():
    # $1,663.20 over 12 months divides evenly, so nothing needs adjusting.
    assert final_installment(Decimal("1663.20"), Decimal(0), 12) == Decimal("138.60")


def test_final_installment_absorbs_rounding():
    # $17,383.78 / 12 rounds to 1,448.65, which overshoots by two cents.
    assert final_installment(Decimal("17383.78"), Decimal(0), 12) == Decimal("1448.63")


@pytest.mark.parametrize("months,apr", [(12, "0"), (36, "0.05"), (60, "0.089")])
def test_payments_always_total_the_contract(months, apr):
    financing = Financing(down_payment_percent=Decimal("0.12"))
    plan = FinancingPlan(months=months, label="p", apr=Decimal(apr))
    quoted = payment_quote(Decimal("19754.30"), financing, plan)
    installments = quoted.monthly * (months - 1) + quoted.final_monthly
    assert quoted.down + installments == quoted.contract_total + quoted.finance_charge
    if apr == "0":
        assert quoted.finance_charge == 0
        assert quoted.total_of_payments == Decimal("19754.30")


def test_schedule_dates_ride_along_with_the_quote():
    financing = Financing(
        down_payment_percent=Decimal("0.12"), signing_date=date(2026, 8, 11)
    )
    plan = FinancingPlan(months=12, label="12-Month Plan", apr=Decimal(0))
    quoted = payment_quote(Decimal(1890), financing, plan)
    assert quoted.down == Decimal("226.80")
    assert quoted.monthly == Decimal("138.60")
    assert quoted.first_payment == date(2026, 9, 11)
    assert quoted.final_payment == date(2027, 8, 11)
    assert quoted.total_of_payments == Decimal("1890.00")


def test_no_dates_when_no_signing_date():
    financing = Financing(down_payment_percent=Decimal("0.12"))
    plan = FinancingPlan(months=12, label="p", apr=Decimal(0))
    quoted = payment_quote(Decimal(1890), financing, plan)
    assert quoted.first_payment is None and quoted.final_payment is None

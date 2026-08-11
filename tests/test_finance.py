"""Down payment and installment math."""

from decimal import Decimal

import pytest

from tmg_quotes.finance import down_payment, monthly_payment, payment_quote
from tmg_quotes.models import Financing, FinancingPlan


def test_down_payment_is_a_percentage_of_the_contract():
    assert down_payment(Decimal(6409), Decimal("0.12")) == Decimal("769.08")


def test_down_payment_rejects_a_percent_written_as_12():
    with pytest.raises(ValueError):
        down_payment(Decimal(6409), Decimal(12))


def test_zero_apr_plan_divides_evenly():
    assert monthly_payment(Decimal(1200), Decimal(0), 12) == Decimal("100.00")


def test_amortized_plan_matches_the_standard_formula():
    # $10,000 at 8.90% APR over 60 months.
    assert monthly_payment(Decimal(10000), Decimal("0.089"), 60) == Decimal("207.10")


def test_no_payment_without_a_principal():
    assert monthly_payment(Decimal(0), Decimal("0.089"), 60) == Decimal("0.00")


def test_payment_quote_splits_down_payment_from_financed_balance():
    financing = Financing(down_payment_percent=Decimal("0.12"))
    plan = FinancingPlan(months=60, label="60-Month Plan", apr=Decimal("0.089"))
    quoted = payment_quote(Decimal(6409), financing, plan)
    assert quoted.down == Decimal("769.08")
    assert quoted.financed == Decimal("5639.92")
    assert quoted.monthly == Decimal("116.80")
    assert quoted.finance_charge > 0


def test_plan_without_an_apr_is_not_amortized():
    """A "Fixed Rate" plan has no rate on file, so no payment is invented."""
    financing = Financing(down_payment_percent=Decimal("0.12"))
    plan = FinancingPlan(months=36, label="36-Month Plan", rate_label="Fixed Rate")
    assert payment_quote(Decimal(6409), financing, plan) is None
